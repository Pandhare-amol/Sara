"""
Universal Knowledge Base (RAG) tools for document ingestion and retrieval.

NOTE: saraRagRetrieve and saraRagRemoveDeleted are registered in tools_platform.py
      (the canonical home for all platform services). This module only registers
      tools that are uniquely about document ingestion.
"""

import os
from pathlib import Path
from typing import Any, Dict

from .registry import ToolError, register
from .platform_core import RAG


@register(
    "saraRagIngestDocument",
    description="Ingest a single document (PDF, DOCX, TXT, HTML, Markdown, etc.) into SARA's personal Knowledge Base so she can answer questions about it.",
    tags=["rag", "knowledge", "document"],
)
def ingest_document(args: Dict[str, Any]) -> Dict[str, Any]:
    """Ingest a single document into the RAG Knowledge Base."""
    path = args.get("path") or args.get("file_path")
    if not path:
        raise ToolError("Parameter 'path' is required.")

    resolved_path = Path(os.path.expandvars(os.path.expanduser(path))).resolve()
    if not resolved_path.exists() or not resolved_path.is_file():
        raise ToolError(f"File not found: {resolved_path}")

    result = RAG.index_path(str(resolved_path), limit_files=1)

    if result.get("error"):
        raise ToolError(result["error"])

    indexed = result.get("indexed", 0)
    updated = result.get("updated", 0)
    total = result.get("total_chunks", 0)

    if indexed == 0 and updated == 0:
        return {
            "result": f"{resolved_path.name} was already up-to-date in the knowledge base.",
            "chunks_total": total,
            "status": "skipped",
        }

    return {
        "result": f"Successfully ingested '{resolved_path.name}' into the knowledge base ({total} total chunks).",
        "chunks_indexed": indexed + updated,
        "total_chunks": total,
        "status": "indexed",
    }


@register(
    "saraRagIndexFolder",
    description="Index an entire folder of documents (PDF, DOCX, TXT, Markdown, code files) into SARA's Knowledge Base for semantic retrieval.",
    tags=["rag", "knowledge", "folder"],
)
def index_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    """Index an entire folder into the RAG Knowledge Base."""
    path = args.get("path") or args.get("folder_path")
    if not path:
        raise ToolError("Parameter 'path' is required.")

    limit = int(args.get("limit", 200))
    result = RAG.index_path(path, limit_files=limit)

    if result.get("error"):
        raise ToolError(result["error"])

    indexed = result.get("indexed", 0)
    updated = result.get("updated", 0)
    skipped = result.get("skipped", 0)
    total = result.get("total_chunks", 0)

    return {
        "result": (
            f"Folder indexed successfully. "
            f"New: {indexed}, Updated: {updated}, Skipped (unchanged): {skipped}. "
            f"Total chunks in knowledge base: {total}."
        ),
        "stats": {
            "indexed": indexed,
            "updated": updated,
            "skipped": skipped,
            "total_chunks": total,
            "path": result.get("path", path),
        },
    }


__all__ = ["ingest_document", "index_folder"]
