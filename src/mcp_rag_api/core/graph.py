"""Grafo da base RAG: nós ligados por similaridade de cosseno real dos embeddings.

Nível "documents" usa o centroide de cada documento; nível "chunks" usa os embeddings dos chunks
(limitado a MAX_CHUNK_NODES por causa do navegador). Arestas = top-k vizinhos de cada nó, filtrados
por threshold de similaridade (kind "semantic"). No nível "documents" entram também os links
explícitos (kind "link": [[wikilinks]] e manuais), independentes do threshold; se o par também é
vizinho semântico, a aresta vira "link" com a similaridade junto.

Desempenho (plan-web-22): os vetores vêm numa consulta só e os vizinhos são calculados em memória
com numpy (produto de matrizes em blocos, numa thread). Antes era um LATERAL por nó no Postgres que
não usava o índice vetorial: com ~1.900 documentos levava ~2,3 s e, no nível chunks, ~3,4 min
prendendo o banco. O resultado (top-MAX_K vizinhos de cada nó) fica em cache por nível/coleção,
invalidado pela assinatura da base (_STAMP_SQL) — slider de similaridade e top-k só filtram.
"""

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Literal

import numpy as np

from ..db import pool, records

MAX_CHUNK_NODES = 2000  # teto do nível "chunks" para não derrubar o navegador
MAX_K = 20  # maior top-k aceito pelo endpoint: o cache guarda esses vizinhos e filtra por k/threshold
_BLOCK_ROWS = 512  # linhas por bloco do produto de matrizes (memória ≈ bloco × n × 4 bytes)
_CACHE_SIZE = 8
_CACHE_TTL_S = 600  # rede de segurança além da assinatura (ex.: reindex que não mexe em updated_at)

_DOC_NODES_SQL = """
    SELECT d.id, d.title, c.name AS collection, coalesce(ch.n, 0) AS chunks, d.centroid AS vector
    FROM documents d
    JOIN collections c ON c.id = d.collection_id
    LEFT JOIN (SELECT document_id, count(*) AS n FROM chunks GROUP BY document_id) ch ON ch.document_id = d.id
    WHERE d.status = 'active' AND d.centroid IS NOT NULL
      AND ($1::text IS NULL OR c.name = $1)
    ORDER BY c.name, d.title
"""

_CHUNK_NODES_SQL = """
    SELECT c.id, c.document_id, c.chunk_index, d.title, col.name AS collection, c.embedding AS vector
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    JOIN collections col ON col.id = d.collection_id
    WHERE d.status = 'active'
      AND ($1::text IS NULL OR col.name = $1)
    ORDER BY c.id
    LIMIT $2
"""

_LINK_EDGES_SQL = """
    SELECT l.source_id AS source, l.target_id AS target, l.kind AS link_kind, l.note,
           round((1 - (s.centroid <=> t.centroid))::numeric, 4)::float AS similarity
    FROM document_links l
    JOIN documents s ON s.id = l.source_id
    JOIN documents t ON t.id = l.target_id
    JOIN collections cs ON cs.id = s.collection_id
    JOIN collections ct ON ct.id = t.collection_id
    WHERE s.status = 'active' AND t.status = 'active'
      AND s.centroid IS NOT NULL AND t.centroid IS NOT NULL
      AND ($1::text IS NULL OR (cs.name = $1 AND ct.name = $1))
"""

# Assinatura barata (~2 mil linhas, poucos ms) de tudo o que muda o grafo: documentos ativos (conteúdo,
# arquivamento, coleção, pasta), links e chunks. Mudou a assinatura, o cache é recalculado.
_STAMP_SQL = """
    SELECT (SELECT count(*) FROM documents WHERE status = 'active'),
           (SELECT max(updated_at) FROM documents),
           (SELECT coalesce(sum(hashtext(concat_ws(':', id, collection_id, folder_id))), 0)
              FROM documents WHERE status = 'active'),
           (SELECT count(*) FROM document_links),
           (SELECT max(created_at) FROM document_links),
           (SELECT count(*) FROM chunks)
"""


def top_neighbors(vectors: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Top-k vizinhos por cosseno de cada linha (sem ela mesma), do mais para o menos parecido.

    Produto de matrizes em blocos de _BLOCK_ROWS linhas: com ~6 mil vetores a matriz inteira de
    similaridades teria ~150 MB; em blocos o pico fica em poucos MB."""
    n = len(vectors)
    k = min(k, n - 1)
    if k <= 0:
        return np.empty((n, 0), dtype=np.int64), np.empty((n, 0), dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    unit = (vectors / norms).astype(np.float32, copy=False)
    idx = np.empty((n, k), dtype=np.int64)
    sims = np.empty((n, k), dtype=np.float32)
    for start in range(0, n, _BLOCK_ROWS):
        block = unit[start : start + _BLOCK_ROWS] @ unit.T
        rows = np.arange(block.shape[0])
        block[rows, start + rows] = -np.inf  # o próprio nó não é vizinho
        part = np.argpartition(-block, k - 1, axis=1)[:, :k]
        part_sims = np.take_along_axis(block, part, axis=1)
        order = np.argsort(-part_sims, axis=1, kind="stable")
        end = start + block.shape[0]
        idx[start:end] = np.take_along_axis(part, order, axis=1)
        sims[start:end] = np.take_along_axis(part_sims, order, axis=1)
    return idx, sims


@dataclass
class _Base:
    """Nós de um nível/coleção + top-MAX_K vizinhos de cada um (o que é caro de calcular)."""

    stamp: tuple
    built_at: float
    nodes: list[dict]
    neighbor_idx: np.ndarray
    neighbor_sim: np.ndarray
    explicit: list[dict]


_cache: "OrderedDict[tuple, _Base]" = OrderedDict()
_locks: dict[tuple, asyncio.Lock] = {}


def clear_cache() -> None:
    _cache.clear()


def _vectors_and_neighbors(rows: list) -> tuple[np.ndarray, np.ndarray]:
    if not rows:
        return np.empty((0, 0), dtype=np.int64), np.empty((0, 0), dtype=np.float32)
    matrix = np.stack([r["vector"].to_numpy().astype(np.float32, copy=False) for r in rows])
    return top_neighbors(matrix, MAX_K)


async def _base(level: str, collection: str | None) -> _Base:
    key = (level, collection)
    stamp = tuple(await pool().fetchrow(_STAMP_SQL))
    cached = _cache.get(key)
    if cached and cached.stamp == stamp and time.monotonic() - cached.built_at < _CACHE_TTL_S:
        _cache.move_to_end(key)
        return cached
    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:  # duas abas pedindo o mesmo grafo: calcula uma vez só
        cached = _cache.get(key)
        if cached and cached.stamp == stamp and time.monotonic() - cached.built_at < _CACHE_TTL_S:
            return cached
        if level == "chunks":
            rows = await pool().fetch(_CHUNK_NODES_SQL, collection, MAX_CHUNK_NODES)
            explicit: list[dict] = []
        else:
            rows = await pool().fetch(_DOC_NODES_SQL, collection)
            explicit = records(await pool().fetch(_LINK_EDGES_SQL, collection))
        # CPU fora do event loop: o servidor roda com 1 worker e não pode travar as outras requisições
        neighbor_idx, neighbor_sim = await asyncio.to_thread(_vectors_and_neighbors, rows)
        nodes = records(rows)
        for n in nodes:
            n.pop("vector", None)
        node_ids = {n["id"] for n in nodes}
        explicit = [e for e in explicit if e["source"] in node_ids and e["target"] in node_ids]
        base = _Base(stamp, time.monotonic(), nodes, neighbor_idx, neighbor_sim, explicit)
        _cache[key] = base
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
        return base


def _merge_link_edges(semantic: list[dict], explicit: list[dict]) -> list[dict]:
    """Une as arestas semânticas com os links explícitos: um par ligado vira kind "link"."""
    by_pair: dict[frozenset[str], dict] = {}
    for e in semantic:
        by_pair[frozenset((e["source"], e["target"]))] = {**e, "kind": "semantic"}
    for link in explicit:
        pair = frozenset((link["source"], link["target"]))
        current = by_pair.get(pair)
        if current and current["kind"] == "link":
            # A -> B e B -> A (ou wikilink + manual): uma aresta só, juntando os tipos
            current["link_kinds"] = sorted({*current["link_kinds"], link["link_kind"]})
            current["note"] = current["note"] or link["note"]
            continue
        by_pair[pair] = {
            "source": link["source"],
            "target": link["target"],
            "similarity": link["similarity"],
            "kind": "link",
            "link_kinds": [link["link_kind"]],
            "note": link["note"],
        }
    # links primeiro, depois semânticas da mais forte para a mais fraca
    return sorted(by_pair.values(), key=lambda e: (e["kind"] != "link", -(e["similarity"] or 0)))


def _dedupe_edges(rows: list[dict]) -> list[dict]:
    """Arestas dirigidas (cada nó lista seus top-k): mantém cada par uma única vez."""
    best: dict[frozenset[str], dict] = {}
    for r in rows:
        pair = frozenset((r["source"], r["target"]))
        if pair not in best or r["similarity"] > best[pair]["similarity"]:
            best[pair] = r
    return sorted(best.values(), key=lambda e: -e["similarity"])


async def build_graph(
    level: Literal["documents", "chunks"],
    collection: str | None,
    min_similarity: float,
    k: int,
) -> dict:
    base = await _base(level, collection)
    nodes = base.nodes
    k = max(0, min(k, base.neighbor_idx.shape[1] if base.neighbor_idx.ndim == 2 else 0))
    edges = []
    for i in range(len(nodes)):
        for j, sim in zip(base.neighbor_idx[i, :k], base.neighbor_sim[i, :k], strict=True):
            if sim < min_similarity:
                break  # vizinhos vêm ordenados: o resto é mais fraco
            edges.append({"source": nodes[i]["id"], "target": nodes[j]["id"], "similarity": round(float(sim), 4)})
    counts: dict[str, int] = {}
    for n in nodes:
        counts[n["collection"]] = counts.get(n["collection"], 0) + 1
    return {
        "level": level,
        "collections": [{"name": name, "count": count} for name, count in sorted(counts.items())],
        "nodes": nodes,
        "edges": _merge_link_edges(_dedupe_edges(edges), base.explicit),
    }
