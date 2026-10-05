"""Sinh docs/erd.md (ở gốc repo) (Mermaid erDiagram) từ app/db/models.py chỉ bằng stdlib `ast`
— không cần cài thêm thư viện hay kết nối DB.

Chạy từ thư mục backend/:  python scripts/generate_erd.py
"""

from __future__ import annotations

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "app" / "db" / "models.py"
OUT = ROOT.parent / "docs" / "erd.md"


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Call):
        func = node.func
        return func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
    return None


def _column_type(annotation: ast.AST) -> str:
    text = ast.unparse(annotation)
    for marker in ("uuid.UUID", "datetime", "Numeric", "bool", "int", "str"):
        if marker in text:
            return {"uuid.UUID": "uuid", "Numeric": "numeric"}.get(marker, marker)
    return "text"


def parse_models() -> list[dict]:
    tree = ast.parse(MODELS.read_text(encoding="utf-8"))
    tables: list[dict] = []
    for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
        table_name = None
        columns: list[dict] = []
        for stmt in cls.body:
            if (
                isinstance(stmt, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "__tablename__" for t in stmt.targets)
                and isinstance(stmt.value, ast.Constant)
            ):
                table_name = stmt.value.value
            if isinstance(stmt, ast.AnnAssign) and _call_name(stmt.value) == "mapped_column":
                call = stmt.value
                fk = None
                is_pk = False
                for arg in call.args:
                    if _call_name(arg) == "ForeignKey":
                        fk = ast.literal_eval(arg.args[0]).split(".")[0]
                for kw in call.keywords:
                    if kw.arg == "primary_key" and isinstance(kw.value, ast.Constant):
                        is_pk = bool(kw.value.value)
                columns.append(
                    {
                        "name": stmt.target.id,
                        "type": _column_type(stmt.annotation),
                        "pk": is_pk,
                        "fk": fk,
                    }
                )
        if table_name:
            tables.append({"name": table_name, "columns": columns})
    return tables


def render(tables: list[dict]) -> str:
    lines = [
        "# ERD — POS System (Release 1)",
        "",
        "> File sinh tự động bởi `scripts/generate_erd.py` từ `app/db/models.py`. "
        "Không sửa tay — sửa model rồi chạy lại script.",
        "",
        "```mermaid",
        "erDiagram",
    ]
    for table in tables:
        for col in table["columns"]:
            if col["fk"]:
                lines.append(f'    "{col["fk"]}" ||--o{{ "{table["name"]}" : "{col["name"]}"')
    for table in tables:
        lines.append(f'    "{table["name"]}" {{')
        for col in table["columns"]:
            tag = " PK" if col["pk"] else (" FK" if col["fk"] else "")
            lines.append(f"        {col['type']} {col['name']}{tag}")
        lines.append("    }")
    lines += ["```", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(render(parse_models()), encoding="utf-8")
    print(f"Đã ghi {OUT}")
