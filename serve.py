#!/usr/bin/env python3
"""Serve the local paper library and save each paper's annotations beside it."""

import argparse
import json
import mimetypes
import re
from datetime import datetime, timezone
from html import escape
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from string import Template
from tempfile import NamedTemporaryFile
from threading import Lock
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "reader"
VIEWS = {"study": "핵심 정리", "source": "영어 원문"}
PAPER_ID = r"[a-zA-Z0-9][a-zA-Z0-9._-]*"
NOTE_ID = r"[0-9a-f]{32}"
NOTE_LOCK = Lock()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def template(name, **values):
    return Template((ASSETS / name).read_text(encoding="utf-8")).substitute(values)


def paper_index():
    return sorted(
        path.parent for path in ROOT.glob("*/paper.json")
        if re.fullmatch(PAPER_ID, path.parent.name)
    )


def render_library():
    items = []
    for folder in paper_index():
        paper = read_json(folder / "paper.json")
        items.append(
            f'<li><a href="/{folder.name}/"><strong lang="en">{escape(paper["title"])}</strong>'
            f'<span>{escape(paper["venue"])} · {escape(paper["short_title"])}</span></a></li>'
        )
    return template("library.html", papers="\n".join(items) or "<li>등록된 논문이 없습니다.</li>")


def study_figure(figure):
    caption_id = "study-figure-caption"
    label = escape(figure["label"])
    return f"""
      <figure class="paper-figure featured-figure" id="study-figure">
        <a class="figure-link" href="original.pdf#page={int(figure["page"])}" target="_blank" rel="noopener">
          <img src="figures/{escape(figure["file"])}" width="{int(figure["width"])}" height="{int(figure["height"])}"
               alt="{escape(figure["alt"])}">
        </a>
        <figcaption>
          <span id="{caption_id}" data-anchor="{label}"><strong>{label}.</strong> {escape(figure["caption"])}</span>
          {annotate_button(caption_id, f"Add a note to {label}")}
        </figcaption>
      </figure>"""


def annotate_button(anchor, label):
    return (
        f'<button class="button anchor-action" type="button" data-annotate="{escape(anchor)}" '
        f'aria-label="{escape(label)}" hidden><svg class="icon" aria-hidden="true">'
        '<use href="#i-note"/></svg></button>'
    )


def study_table(table):
    head = "".join(f'<th scope="col">{escape(label)}</th>' for label in table["head"])
    rows = []
    for label, *values in table["rows"]:
        cells = "".join(f'<td>{escape(value)}</td>' for value in values)
        rows.append(f'<tr><th scope="row">{escape(label)}</th>{cells}</tr>')
    return f'<div class="table-scroll"><table><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


def study_evidence(entries):
    output = []
    for entry in entries:
        anchor = escape(entry["id"])
        title = escape(entry["title"])
        paragraphs = "".join(
            f'<p id="{anchor}-{escape(paragraph["id"])}" data-anchor="{title}">'
            f'{escape(paragraph["text"])}</p>'
            for paragraph in entry["body"]
        )
        sources = "".join(
            f'<a href="?view=source#{escape(source["anchor"])}">{escape(source["label"])}</a>'
            for source in entry.get("sources", [])
        )
        table = study_table(entry["table"]) if "table" in entry else ""
        output.append(
            f'<details class="evidence" id="{anchor}"><summary>{title}'
            '<svg class="icon" aria-hidden="true"><use href="#i-down"/></svg></summary>'
            f'<div class="evidence-body">{paragraphs}{table}<div class="evidence-links">{sources}</div></div></details>'
        )
    return "\n".join(output)


def render_study(study):
    sections = []
    for section in study["sections"]:
        anchor = escape(section["id"])
        title = escape(section["title"])
        sections.append(
            f'<section class="study-section" id="{anchor}"><div class="section-heading"><h2>{title}</h2>'
            f'{annotate_button(f"{anchor}-summary", "Add a note to " + section["title"])}</div>'
            f'<p id="{anchor}-summary" data-anchor="{title}">{escape(section["summary"])}</p>'
            f'{study_evidence(section["evidence"])}</section>'
        )
    return template(
        "study.html", claim=escape(study["claim"]["text"]),
        claim_evidence=study_evidence(study["claim"]["evidence"]),
        figure=study_figure(study["figure"]) if "figure" in study else "",
        sections="\n".join(sections),
    )


def render_paper(folder, view):
    paper = read_json(folder / "paper.json")
    tabs = []
    for key, label in VIEWS.items():
        current = ' aria-current="page"' if view == key else ""
        tabs.append(f'<a href="?view={key}"{current}>{label}</a>')
    outline = paper["outline"]
    if view == "study":
        study = read_json(folder / "study.json")
        outline = [("claim", "Main claim"), *((part["id"], part["title"]) for part in study["sections"])]
        content = render_study(study)
    else:
        content = (folder / "source.html").read_text(encoding="utf-8")
    sections = "".join(
        f'<li><a href="#{escape(anchor)}">{escape(label)}</a></li>'
        for anchor, label in outline
    )
    metadata = {key: escape(paper[key]) for key in
                ("title", "authors", "venue", "pages", "source_url", "license_url")}
    return template(
        "paper.html", **metadata, paper_id=folder.name, view=view,
        tabs="".join(tabs), sections=sections, content=content,
    )


def read_notes(folder):
    try:
        return read_json(folder / "annotations.json")
    except FileNotFoundError:
        return []


def write_notes(folder, notes):
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=folder, delete=False) as output:
        temp = Path(output.name)
        try:
            json.dump(notes, output, indent=2, ensure_ascii=False)
            output.write("\n")
            output.close()
            temp.replace(folder / "annotations.json")
        finally:
            temp.unlink(missing_ok=True)


def note_fields(data):
    kind, body = data.get("kind"), data.get("body")
    if kind not in ("note", "question") or not isinstance(body, str) or not 0 < len(body.strip()) <= 6000:
        raise ValueError("주석 또는 질문을 1–6000자로 입력해 주세요.")
    return {"kind": kind, "body": body.strip()}


def note_anchor(data):
    if data is None:
        return None
    if not isinstance(data, dict):
        raise ValueError("주석 위치가 올바르지 않습니다.")
    block, label, view = data.get("block"), data.get("label"), data.get("view")
    if (view not in VIEWS or not isinstance(block, str) or
            not re.fullmatch(r"[a-z][\w-]{0,100}", block) or
            not isinstance(label, str) or not 0 < len(label) <= 180):
        raise ValueError("주석 위치가 올바르지 않습니다.")
    anchor = {"view": view, "block": block, "label": label}
    if "quote" in data:
        quote, start, end = data.get("quote"), data.get("start"), data.get("end")
        if (not isinstance(quote, str) or not 0 < len(quote) <= 3000 or
                type(start) is not int or type(end) is not int or not 0 <= start < end <= 50000):
            raise ValueError("한 문단에서 3000자 이내로 선택해 주세요.")
        anchor.update(quote=quote, start=start, end=end)
    return anchor


class ReaderHandler(BaseHTTPRequestHandler):
    def reply(self, status, body, content_type, *, cache="no-store"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json_reply(self, status, value):
        self.reply(status, json.dumps(value, ensure_ascii=False), "application/json; charset=utf-8")

    def file_reply(self, path):
        if not path.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.reply(200, path.read_bytes(), content_type)

    def loopback_host(self):
        return self.headers.get("Host", "") in {
            f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}",
        }

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.loopback_host():
            self.send_error(403)
            return
        target = urlsplit(self.path)
        path = target.path
        api = re.fullmatch(rf"/api/papers/({PAPER_ID})/annotations", path)
        if api:
            self.annotations(api.group(1))
            return
        if path == "/":
            self.reply(200, render_library(), "text/html; charset=utf-8")
            return
        shared = re.fullmatch(r"/reader/(base\.css|tokens\.css|styles\.css|reader\.js)", path)
        if shared:
            self.file_reply(ASSETS / shared.group(1))
            return
        paper = re.fullmatch(rf"/({PAPER_ID})(?:/(.*))?", path)
        if not paper:
            self.send_error(404)
            return
        slug, resource = paper.groups()
        folder = ROOT / slug
        if not (folder / "paper.json").is_file():
            self.send_error(404)
        elif resource is None:
            self.send_response(HTTPStatus.TEMPORARY_REDIRECT)
            self.send_header("Location", f"/{slug}/" + ("?" + target.query if target.query else ""))
            self.end_headers()
        elif resource == "":
            view = parse_qs(target.query).get("view", ["study"])[0]
            if view not in VIEWS:
                self.send_error(404)
                return
            self.reply(200, render_paper(folder, view), "text/html; charset=utf-8")
        elif resource == "original.pdf" or re.fullmatch(r"figures/[\w-]+\.png", resource):
            self.file_reply(folder / resource)
        else:
            self.send_error(404)

    def do_POST(self):
        self.mutate()

    def do_PATCH(self):
        self.mutate()

    def do_DELETE(self):
        self.mutate()

    def mutate(self):
        api = re.fullmatch(rf"/api/papers/({PAPER_ID})/annotations(?:/({NOTE_ID}))?", self.path)
        if not api or (self.command == "POST") != (api.group(2) is None):
            self.send_error(404)
            return
        host = self.headers.get("Host")
        if not self.loopback_host() or self.headers.get("Origin") not in (None, f"http://{host}"):
            self.send_error(403)
            return
        self.annotations(*api.groups())

    def request_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if self.headers.get_content_type() != "application/json" or not 0 < size <= 65536:
            raise ValueError("요청 형식이 올바르지 않습니다.")
        data = json.loads(self.rfile.read(size))
        if not isinstance(data, dict):
            raise ValueError("요청 형식이 올바르지 않습니다.")
        return data

    def annotations(self, slug, note_id=None):
        folder = ROOT / slug
        if not (folder / "paper.json").is_file():
            self.json_reply(404, {"error": "논문을 찾을 수 없습니다."})
            return
        try:
            self.update_annotations(folder, note_id)
        except (ValueError, UnicodeError):
            self.json_reply(400, {"error": "주석 내용을 확인한 뒤 다시 시도해 주세요."})
        except OSError:
            self.json_reply(500, {"error": "주석 파일에 접근할 수 없습니다."})

    def update_annotations(self, folder, note_id):
        method = self.command
        fields = note_fields(self.request_json()) if method == "PATCH" else None
        if method == "POST":
            data = self.request_json()
            fields = {**note_fields(data), "anchor": note_anchor(data.get("anchor"))}
        updated_at = datetime.now(timezone.utc).isoformat()
        with NOTE_LOCK:
            notes = read_notes(folder)
            if method == "POST":
                notes.append({
                    "id": uuid4().hex, **fields, "created_at": updated_at, "updated_at": updated_at,
                })
            if method in ("PATCH", "DELETE"):
                existing = next((note for note in notes if note["id"] == note_id), None)
                if existing is None:
                    self.json_reply(404, {"error": "주석을 찾을 수 없습니다. 목록을 다시 불러와 주세요."})
                    return
                if method == "PATCH":
                    existing.update(fields, updated_at=updated_at)
                else:
                    notes.remove(existing)
            if method not in ("GET", "HEAD"):
                write_notes(folder, notes)
        self.json_reply(201 if method == "POST" else 200, notes)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="local HTTP port (default 8765)")
    args = parser.parse_args()
    with ThreadingHTTPServer(("127.0.0.1", args.port), ReaderHandler) as server:
        print(f"논문 노트 · http://127.0.0.1:{server.server_port}/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
