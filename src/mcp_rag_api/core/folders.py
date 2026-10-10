"""Pastas aninhadas dentro das coleções (plan-web-14) — organização da tela Notas, só no web-server.

A coleção é a pasta principal (o "projeto"); dentro dela, pastas sem limite de profundidade
(`parent_id` NULL = filha direta da coleção). Escopo de acesso, MCP e busca seguem por coleção.
Integridade fica no banco (migração 006): FK composta garante pasta-mãe e nota na mesma coleção,
e mudar a coleção de uma pasta leva a subárvore (pastas e notas) junto via ON UPDATE CASCADE.
"""

import uuid

import asyncpg

from ..db import audit, pool, records
from ..security import KBError, NotFound, Principal
from .documents import parse_uuid

FOLDER_NAME_MAX = 120


def validate_folder_name(name: str) -> str:
    """Nome livre (é só rótulo, sempre exibido escapado), sem quebra de linha, 1–120 chars."""
    cleaned = " ".join(name.split())
    if not cleaned or len(cleaned) > FOLDER_NAME_MAX:
        raise KBError(f"Nome de pasta inválido: use de 1 a {FOLDER_NAME_MAX} caracteres.")
    return cleaned


async def _lock_collection(conn: asyncpg.Connection, collection_id: uuid.UUID) -> None:
    # serializa mudanças de árvore por coleção (a checagem de ciclo lê a árvore antes de gravar)
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext('folders:' || $1::text))", str(collection_id))


async def _collection(conn: asyncpg.Connection, p: Principal, name: str) -> uuid.UUID:
    p.require_collection(name)
    cid = await conn.fetchval("SELECT id FROM collections WHERE name = $1", name)
    if cid is None:
        raise NotFound(f"Pasta principal '{name}' não existe.")
    return cid


async def _load_folder(conn: asyncpg.Connection, p: Principal, folder_id: str) -> dict:
    row = await conn.fetchrow(
        """
        SELECT f.id, f.collection_id, c.name AS collection, f.parent_id, f.name
        FROM folders f JOIN collections c ON c.id = f.collection_id WHERE f.id = $1
        """,
        parse_uuid(folder_id, "folder_id"),
    )
    if row is None:
        raise NotFound(f"Pasta {folder_id} não encontrada.")
    p.require_collection(row["collection"])
    return dict(row)  # UUIDs nativos: são comparados e reusados nas queries


async def _parent_in(
    conn: asyncpg.Connection, p: Principal, parent_id: str | None, collection_id: uuid.UUID
) -> uuid.UUID | None:
    if parent_id is None:
        return None
    parent = await _load_folder(conn, p, parent_id)
    if parent["collection_id"] != collection_id:
        raise KBError("A pasta de destino é de outra pasta principal.")
    return parent["id"]


async def ensure_folder_in(p: Principal, folder_id: str, collection: str) -> None:
    """Valida (sem gravar) que a pasta existe e é da coleção — antes de criar/mover a nota."""
    async with pool().acquire() as conn:
        folder = await _load_folder(conn, p, folder_id)
    if folder["collection"] != collection:
        raise KBError("A pasta de destino é de outra pasta principal.")


async def list_folders(p: Principal) -> list[dict]:
    p.require("read")
    rows = await pool().fetch(
        """
        SELECT f.id, c.name AS collection, f.parent_id, f.name
        FROM folders f JOIN collections c ON c.id = f.collection_id
        ORDER BY c.name, lower(f.name)
        """
    )
    return [r for r in records(rows) if p.can_access_collection(r["collection"])]


async def create_folder(p: Principal, collection: str, name: str, parent_id: str | None = None) -> dict:
    p.require("write")
    name = validate_folder_name(name)
    async with pool().acquire() as conn, conn.transaction():
        cid = await _collection(conn, p, collection)
        await _lock_collection(conn, cid)
        parent = await _parent_in(conn, p, parent_id, cid)
        fid = await conn.fetchval(
            "INSERT INTO folders (collection_id, parent_id, name, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
            cid,
            parent,
            name,
            p.actor,
        )
        await audit(conn, p.actor, "folder.create", str(fid), collection=collection, parent_id=parent_id, name=name)
    return {"id": str(fid), "collection": collection, "parent_id": parent_id, "name": name}


async def rename_folder(p: Principal, folder_id: str, name: str) -> dict:
    p.require("write")
    name = validate_folder_name(name)
    async with pool().acquire() as conn, conn.transaction():
        folder = await _load_folder(conn, p, folder_id)
        await conn.execute("UPDATE folders SET name = $2, updated_at = now() WHERE id = $1", folder["id"], name)
        await audit(conn, p.actor, "folder.rename", folder_id, old=folder["name"], new=name)
    return {"id": folder_id, "name": name}


async def move_folder(p: Principal, folder_id: str, collection: str, parent_id: str | None = None) -> dict:
    """Move a pasta (com tudo o que tem dentro) para outra pasta-mãe — inclusive de outra coleção."""
    p.require("write")
    async with pool().acquire() as conn, conn.transaction():
        folder = await _load_folder(conn, p, folder_id)
        dest_cid = await _collection(conn, p, collection)
        for cid in sorted({folder["collection_id"], dest_cid}, key=str):  # ordem fixa: sem deadlock
            await _lock_collection(conn, cid)
        parent = await _parent_in(conn, p, parent_id, dest_cid)
        if parent is not None:
            # destino não pode ser a própria pasta nem algo dentro dela
            inside = await conn.fetchval(
                """
                WITH RECURSIVE sub AS (
                  SELECT id FROM folders WHERE id = $1
                  UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
                )
                SELECT EXISTS (SELECT 1 FROM sub WHERE id = $2)
                """,
                folder["id"],
                parent,
            )
            if inside:
                raise KBError("Não dá para mover uma pasta para dentro dela mesma.")
        try:
            await conn.execute(
                "UPDATE folders SET collection_id = $2, parent_id = $3, updated_at = now() WHERE id = $1",
                folder["id"],
                dest_cid,
                parent,
            )
        except asyncpg.UniqueViolationError as e:
            # ON UPDATE CASCADE leva as notas junto; colide se o destino já tem o mesmo external_id
            raise KBError(f"Uma nota desta pasta já existe em '{collection}' (mesmo external_id).") from e
        await audit(
            conn,
            p.actor,
            "folder.move",
            folder_id,
            source=folder["collection"],
            destination=collection,
            parent_id=parent_id,
        )
    return {"id": folder_id, "collection": collection, "parent_id": parent_id}


async def delete_folder(p: Principal, folder_id: str) -> dict:
    """Remove a pasta sem perder nada: subpastas e notas sobem para a pasta-mãe (ou raiz da coleção)."""
    p.require("write")
    async with pool().acquire() as conn, conn.transaction():
        folder = await _load_folder(conn, p, folder_id)
        await _lock_collection(conn, folder["collection_id"])
        fid, parent = folder["id"], folder["parent_id"]
        moved_folders = await conn.execute("UPDATE folders SET parent_id = $2 WHERE parent_id = $1", fid, parent)
        moved_notes = await conn.execute("UPDATE documents SET folder_id = $2 WHERE folder_id = $1", fid, parent)
        await conn.execute("DELETE FROM folders WHERE id = $1", fid)
        await audit(conn, p.actor, "folder.delete", folder_id, collection=folder["collection"], name=folder["name"])
    return {
        "deleted": True,
        "id": folder_id,
        "moved_folders": int(moved_folders.split()[-1]),
        "moved_notes": int(moved_notes.split()[-1]),
    }


async def place_document(p: Principal, document_id: str, folder_id: str | None) -> dict:
    """Põe a nota numa pasta da própria coleção (None = raiz da coleção)."""
    p.require("write")
    async with pool().acquire() as conn, conn.transaction():
        doc = await conn.fetchrow(
            """
            SELECT d.id, d.collection_id, c.name AS collection, d.status
            FROM documents d JOIN collections c ON c.id = d.collection_id WHERE d.id = $1
            """,
            parse_uuid(document_id, "document_id"),
        )
        if doc is None:
            raise NotFound(f"Documento {document_id} não encontrado.")
        p.require_collection(doc["collection"])
        if doc["status"] != "active":
            raise KBError("Documento arquivado não pode ser movido.")
        target = await _parent_in(conn, p, folder_id, doc["collection_id"])
        await conn.execute("UPDATE documents SET folder_id = $2 WHERE id = $1", doc["id"], target)
        await audit(conn, p.actor, "document.place", document_id, collection=doc["collection"], folder_id=folder_id)
    return {"document_id": document_id, "collection": doc["collection"], "folder_id": folder_id}
