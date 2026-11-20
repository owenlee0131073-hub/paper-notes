"use strict";

document.body.classList.add("js-enabled");
const { paper, view, noteStorage } = document.body.dataset;
const endpoint = `/api/papers/${paper}/annotations`;
const viewLinks = new Map([...document.querySelectorAll(".views a")].map(link => [
  link.dataset.view, link.getAttribute("href"),
]));
const content = document.querySelector("#paper-content");
const panel = document.querySelector("#annotations");
const topbar = document.querySelector(".topbar");
const heading = document.querySelector("#annotations-title");
const outline = document.querySelector("#outline");
const outlineLinks = [...outline.querySelectorAll("a")];
const collapsedOutline = window.matchMedia("(max-width: 64rem)");
const compact = window.matchMedia("(max-width: 48rem)");
const mobileNotes = document.querySelector("[data-open-notes]");
const form = document.querySelector("#note-form");
const kindFields = form.querySelector("fieldset");
const field = document.querySelector("#note-body");
const errorMessage = document.querySelector("#form-error");
const formAnchor = document.querySelector("#form-anchor");
const formTitle = document.querySelector("#form-title");
const newNote = document.querySelector("#new-note");
const saveNote = document.querySelector("#save-note");
const cancelNote = document.querySelector("#cancel-note");
const noteList = document.querySelector("#note-list");
const annotationStream = document.querySelector("#annotation-stream");
const noteStatus = document.querySelector("#notes-status");
const noteCount = document.querySelector("#note-count");
const empty = document.querySelector("#notes-empty");
const retry = document.querySelector("#retry-notes");
const selectionAction = document.querySelector("#selection-action");
const noteJumpIcon = document.querySelector("#note-jump-icon");
const blocks = new Map([...content.querySelectorAll("[data-anchor]")].map(block => [block.id, block]));
const annotateButtons = content.querySelectorAll("[data-annotate]");

let notes = [];
let loaded = false;
let pendingSelection = null;
let draft = null;
let busy = false;
let returnFocus = null;
let activeNoteId = null;
let annotationFrame = 0;

function browserNoteRequest(method, id, payload) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("paper-notes", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("annotations");
    open.onerror = () => reject(new Error("브라우저 저장소에 접근할 수 없어요."));
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("annotations", method === "GET" ? "readonly" : "readwrite");
      const store = transaction.objectStore("annotations");
      const read = store.get(paper);
      let current;
      let failure;

      transaction.oncomplete = () => {
        database.close();
        resolve(current);
      };
      transaction.onabort = () => {
        database.close();
        reject(failure || new Error("브라우저에 주석을 저장하지 못했어요."));
      };

      read.onsuccess = () => {
        current = read.result || [];
        if (method === "GET") return;
        const timestamp = new Date().toISOString();
        if (method === "POST") {
          current.push({ id: crypto.randomUUID().replaceAll("-", ""), ...payload, created_at: timestamp, updated_at: timestamp });
        } else {
          const index = current.findIndex(note => note.id === id);
          if (index < 0) {
            failure = new Error("주석을 찾을 수 없어요. 페이지를 새로고침해 주세요.");
            transaction.abort();
            return;
          }
          if (method === "DELETE") current.splice(index, 1);
          else Object.assign(current[index], payload, { updated_at: timestamp });
        }
        store.put(current, paper);
      };
    };
  });
}

async function requestNotes(method = "GET", id, payload) {
  if (noteStorage === "browser") return browserNoteRequest(method, id, payload);
  const options = { method };
  if (payload) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(id ? `${endpoint}/${id}` : endpoint, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "주석 요청을 처리하지 못했어요.");
  return data;
}

function syncLayout() {
  outline.open = !collapsedOutline.matches;
  if (!compact.matches) panel.classList.remove("is-open");
  layoutAnnotations();
  positionSelectionAction();
}

function openPanel() {
  panel.classList.add("is-open");
  returnFocus = document.activeElement;
}

function closePanel() {
  panel.classList.remove("is-open");
  (returnFocus?.isConnected && !returnFocus.hidden ? returnFocus : mobileNotes).focus();
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function action(label, handler) {
  const button = create("button", "text-action", label);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function noteCard(note) {
  const card = create("li", "note-card");
  card.id = `note-${note.id}`;
  card.tabIndex = -1;
  card.addEventListener("click", event => {
    if (!event.target.closest("a, button") && document.getSelection()?.isCollapsed) activateNote(note.id);
  });
  card.addEventListener("focusin", () => activateNote(note.id));
  const top = create("div", "note-card-heading");
  const type = create("strong", "note-kind", note.kind === "question" ? "질문" : "주석");
  const time = create("time", "", new Intl.DateTimeFormat("ko", { dateStyle: "medium" })
    .format(new Date(note.created_at)));
  time.dateTime = note.created_at;
  top.append(type, time);
  card.append(top);
  if (note.anchor) {
    const target = create("a", "note-target");
    const excerpt = create("span", "note-excerpt", note.anchor.quote || note.anchor.label);
    target.append(excerpt, noteJumpIcon.content.cloneNode(true));
    target.href = `${viewLinks.get(note.anchor.view)}#${encodeURIComponent(note.anchor.block)}`;
    if (note.anchor.view === view && document.getElementById(note.anchor.block)) {
      target.addEventListener("click", event => {
        event.preventDefault();
        history.replaceState(null, "", target.hash);
        activateNote(note.id);
        if (compact.matches) closePanel();
        revealAnchor(note.anchor);
      });
    }
    card.append(target);
  }
  card.append(create("p", "note-body", note.body));
  const tools = create("div", "note-tools");
  const remove = action("삭제", () => removeNote(note));
  remove.classList.add("note-delete");
  tools.append(action("수정", () => startDraft(note.anchor, note)), remove);
  card.append(tools);
  return card;
}

function resolveRange(text, { quote, start, end }) {
  if (!quote) return null;
  if (text.slice(start, end) === quote) return { start, end };
  const first = text.indexOf(quote);
  return first >= 0 && first === text.lastIndexOf(quote)
    ? { start: first, end: first + quote.length }
    : null;
}

function quoteRange(block, anchor) {
  const offsets = resolveRange(block.textContent, anchor);
  if (!offsets) return null;

  const range = document.createRange();
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + node.length;
    if (!started && offsets.start < end) {
      range.setStart(node, offsets.start - offset);
      started = true;
    }
    if (started && offsets.end <= end) {
      range.setEnd(node, offsets.end - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

function anchorRect(anchor) {
  const block = anchor?.view === view ? blocks.get(anchor.block) : null;
  if (!block) return null;

  let visible = block;
  for (let details = block.closest("details:not([open])"); details;
    details = details.parentElement.closest("details:not([open])")) {
    visible = details.querySelector(":scope > summary") || details;
  }
  if (visible === block && anchor.quote) {
    const range = quoteRange(block, anchor);
    if (range) {
      const line = [...range.getClientRects()].find(rect => rect.width > 0 && rect.height > 0);
      if (line) return line;
    }
  }
  return visible.getBoundingClientRect();
}

function layoutAnnotations() {
  const entries = [];
  const byCard = new Map(notes.map(note => [`note-${note.id}`, note]));
  for (const card of noteList.children) {
    const note = byCard.get(card.id);
    card.hidden = note.id === draft?.id;
    if (!card.hidden) entries.push({ element: card, anchor: note.anchor });
  }
  if (draft) entries.unshift({ element: form, anchor: draft.anchor });

  const positioned = !compact.matches && entries.length > 0;
  annotationStream.classList.toggle("is-positioned", positioned);
  if (!positioned) {
    annotationStream.style.minBlockSize = "";
    return;
  }

  const origin = annotationStream.getBoundingClientRect().top;
  const gap = parseFloat(getComputedStyle(noteList).rowGap);
  const positions = entries.map(({ element, anchor }) => ({
    element,
    height: element.getBoundingClientRect().height,
    top: Math.max(0, (anchorRect(anchor)?.top ?? origin) - origin),
  })).sort((first, second) => first.top - second.top);
  let bottom = -gap;
  for (const { element, height, top } of positions) {
    const y = Math.max(top, bottom + gap);
    element.style.setProperty("--note-offset", `${y}px`);
    bottom = y + height;
  }
  annotationStream.style.minBlockSize = `${bottom}px`;
}

function scheduleAnnotationLayout() {
  if (annotationFrame) return;
  annotationFrame = requestAnimationFrame(() => {
    annotationFrame = 0;
    layoutAnnotations();
    positionSelectionAction();
  });
}

const painted = new Set();

function paintHighlights() {
  for (const block of painted) {
    for (const mark of block.querySelectorAll("mark[data-note]")) mark.replaceWith(...mark.childNodes);
    block.normalize();
  }
  painted.clear();
  const grouped = new Map();
  const highlights = draft?.anchor?.quote && !draft.id
    ? [...notes, { id: "draft", anchor: draft.anchor }]
    : notes;
  for (const note of highlights) {
    if (note.anchor?.view !== view || !note.anchor.quote) continue;
    const related = grouped.get(note.anchor.block) || [];
    related.push(note);
    grouped.set(note.anchor.block, related);
  }
  for (const [id, related] of grouped) {
    const block = blocks.get(id);
    if (!block) continue;
    const ranges = related.flatMap(note => {
      const range = resolveRange(block.textContent, note.anchor);
      return range ? [{ ...range, note: note.id }] : [];
    });
    if (!ranges.length) continue;
    const tree = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (tree.nextNode()) textNodes.push(tree.currentNode);
    let offset = 0;
    for (const node of textNodes) {
      const text = node.data;
      const slices = ranges
        .filter(range => range.start < offset + text.length && range.end > offset)
        .map(range => ({
          start: Math.max(0, range.start - offset),
          end: Math.min(text.length, range.end - offset),
          note: range.note,
        }));
      offset += text.length;
      if (!slices.length) continue;
      const edges = [...new Set([0, text.length, ...slices.flatMap(range => [range.start, range.end])])]
        .sort((a, b) => a - b);
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < edges.length - 1; index++) {
        const start = edges[index];
        const span = text.slice(start, edges[index + 1]);
        const linked = slices.filter(slice => slice.start <= start && start < slice.end);
        if (linked.length) {
          const mark = create("mark", "note-highlight", span);
          mark.dataset.note = linked.map(slice => slice.note).join(" ");
          fragment.append(mark);
        } else {
          fragment.append(span);
        }
      }
      node.replaceWith(fragment);
    }
    painted.add(block);
  }
}

function syncActiveNote() {
  noteList.querySelector(".is-target")?.classList.remove("is-target");
  content.querySelector(".is-note-target")?.classList.remove("is-note-target");
  for (const mark of content.querySelectorAll("mark.is-target")) mark.classList.remove("is-target");

  const id = draft ? draft.id || "draft" : activeNoteId;
  const anchor = draft ? draft.anchor : notes.find(note => note.id === id)?.anchor;
  document.getElementById(`note-${id}`)?.classList.add("is-target");
  const block = anchor?.view === view ? blocks.get(anchor.block) : null;
  if (block) {
    block.classList.add("is-note-target");
    for (const mark of block.querySelectorAll("mark[data-note]")) {
      if (mark.dataset.note.split(" ").includes(id)) mark.classList.add("is-target");
    }
  }
}

function activateNote(id) {
  activeNoteId = id;
  syncActiveNote();
}

function renderNotes() {
  noteCount.textContent = notes.length;
  empty.hidden = notes.length !== 0 || !form.hidden;
  noteList.replaceChildren(...[...notes].reverse().map(noteCard));
  paintHighlights();
  syncActiveNote();
  layoutAnnotations();
}

async function loadNotes() {
  retry.hidden = true;
  noteStatus.textContent = "주석을 불러오는 중…";
  try {
    notes = await requestNotes();
    loaded = true;
    newNote.hidden = false;
    mobileNotes.hidden = false;
    for (const button of annotateButtons) button.hidden = false;
    noteStatus.textContent = "";
    renderNotes();
  } catch {
    noteStatus.textContent = "주석을 불러오지 못했어요.";
    retry.hidden = false;
    mobileNotes.hidden = false;
  }
}

function selectionAnchor(selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const block = range.startContainer.parentElement?.closest("[data-anchor]");
  if (!block || blocks.get(block.id) !== block || !block.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const selected = range.toString();
  const quote = selected.trim();
  if (!quote || quote.length > 3000) return null;
  const start = before.toString().length + selected.length - selected.trimStart().length;
  return { view, block: block.id, label: block.dataset.anchor, quote, start, end: start + quote.length };
}

function syncSelection() {
  pendingSelection = loaded ? selectionAnchor(document.getSelection()) : null;
  positionSelectionAction();
}

function positionSelectionAction() {
  selectionAction.hidden = !pendingSelection;
  if (!pendingSelection || compact.matches) return;
  const rect = anchorRect(pendingSelection);
  const top = topbar.getBoundingClientRect().bottom;
  if (!rect || rect.bottom <= top || rect.top >= innerHeight) {
    selectionAction.hidden = true;
    return;
  }
  const y = Math.max(top, Math.min(rect.top, innerHeight - selectionAction.offsetHeight));
  selectionAction.style.setProperty("--selection-top", `${y}px`);
  selectionAction.style.setProperty("--selection-left", `${annotationStream.getBoundingClientRect().left}px`);
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

function hasChanges() {
  return draft && (field.value !== draft.body || form.elements.kind.value !== draft.kind);
}

function startDraft(anchor = null, note = null) {
  if (!loaded || busy) return;
  openPanel();
  if (hasChanges()) {
    showError("작성 중인 주석을 저장하거나 취소해 주세요.");
    field.focus();
    return;
  }
  draft = { id: note?.id, anchor, kind: note?.kind || "note", body: note?.body || "" };
  formTitle.textContent = note ? "주석 수정" : "새 주석";
  form.elements.kind.value = draft.kind;
  field.value = draft.body;
  formAnchor.textContent = anchor?.quote || anchor?.label || "";
  formAnchor.hidden = !anchor;
  showError("");
  noteStatus.textContent = "";
  form.hidden = false;
  newNote.hidden = true;
  empty.hidden = true;
  paintHighlights();
  syncActiveNote();
  layoutAnnotations();
  field.focus({ preventScroll: true });
  form.scrollIntoView({ block: "nearest" });
}

function startSelectionDraft(anchor) {
  startDraft(anchor);
  document.getSelection()?.removeAllRanges();
}

function handleNoteShortcut(event) {
  // Option can change the key value (for example, from "m" to "µ").
  if (event.code !== "KeyM" || !event.altKey || !event.metaKey || event.ctrlKey || event.shiftKey
    || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
  if (event.repeat || !loaded || busy) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"))) return;

  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) {
    startDraft();
    return;
  }
  const anchor = selectionAnchor(selection);
  if (anchor) startSelectionDraft(anchor);
}

function finishDraft() {
  form.hidden = true;
  newNote.hidden = false;
  draft = null;
  form.reset();
  showError("");
  empty.hidden = notes.length > 0;
  newNote.focus({ preventScroll: true });
}

function setBusy(value) {
  busy = value;
  for (const control of [saveNote, cancelNote, field, kindFields]) control.disabled = value;
  saveNote.setAttribute("aria-busy", String(value));
  saveNote.textContent = value ? "저장 중…" : "저장";
}

async function removeNote(note) {
  if (busy || !window.confirm("이 주석이나 질문을 삭제할까요?")) return;
  setBusy(true);
  try {
    notes = await requestNotes("DELETE", note.id);
    if (draft?.id === note.id) finishDraft();
    renderNotes();
    noteStatus.textContent = "삭제했어요.";
  } catch {
    noteStatus.textContent = "삭제하지 못했어요. 다시 시도해 주세요.";
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!draft || busy) return;
  const body = field.value.trim();
  if (!body) {
    showError("내용을 입력해 주세요.");
    field.focus();
    return;
  }
  const kind = form.elements.kind.value;
  showError("");
  setBusy(true);
  try {
    const { id, anchor } = draft;
    notes = await requestNotes(id ? "PATCH" : "POST", id, id ? { kind, body } : { kind, body, anchor });
    activeNoteId = id || notes.at(-1)?.id;
    finishDraft();
    renderNotes();
    noteStatus.textContent = "저장했어요.";
  } catch (error) {
    showError(error instanceof SyntaxError ? "저장하지 못했어요. 다시 시도해 주세요." : error.message);
  } finally {
    setBusy(false);
  }
});

function hashTarget() {
  return document.getElementById(location.hash.slice(1));
}

function revealAnchor(anchor) {
  const block = hashTarget();
  if (!block) return;
  let disclosure = block.closest("details");
  while (disclosure) {
    disclosure.open = true;
    disclosure = disclosure.parentElement.closest("details");
  }
  const rect = anchor && anchorRect(anchor);
  if (rect) {
    const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop);
    window.scrollBy({ top: rect.top - padding });
  } else {
    block.scrollIntoView({ block: "start" });
  }
}

let framePending = false;
function updateOutline() {
  framePending = false;
  const atBottom = window.scrollY > 0 && window.scrollY + innerHeight >= document.documentElement.scrollHeight - 2;
  const active = atBottom
    ? outlineLinks.at(-1)
    : outlineLinks.findLast(link => document.getElementById(link.hash.slice(1))?.getBoundingClientRect().top <= 146)
      || outlineLinks[0];
  for (const link of outlineLinks) {
    if (link === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

function scheduleOutline() {
  if (!framePending) requestAnimationFrame(updateOutline);
  framePending = true;
}

outline.addEventListener("click", event => {
  if (collapsedOutline.matches && event.target.closest("a")) outline.open = false;
});
document.addEventListener("selectionchange", syncSelection);
document.addEventListener("keydown", handleNoteShortcut);
selectionAction.addEventListener("pointerdown", event => event.preventDefault());
selectionAction.addEventListener("click", () => {
  if (pendingSelection) startSelectionDraft(pendingSelection);
});
newNote.addEventListener("click", () => startDraft());
mobileNotes.addEventListener("click", () => {
  openPanel();
  heading.focus();
});
document.querySelector("#close-notes").addEventListener("click", closePanel);
panel.addEventListener("keydown", event => {
  if (event.key === "Escape" && compact.matches) closePanel();
});
cancelNote.addEventListener("click", () => {
  finishDraft();
  renderNotes();
});
retry.addEventListener("click", loadNotes);
content.addEventListener("click", event => {
  const button = event.target.closest("[data-annotate]");
  if (button) {
    const block = blocks.get(button.dataset.annotate);
    if (block) startDraft({ view, block: block.id, label: block.dataset.anchor });
    return;
  }
  const mark = event.target.closest("mark[data-note]");
  if (!document.getSelection()?.isCollapsed) return;
  if (!mark) {
    if (!draft) activateNote(null);
    return;
  }
  const ids = mark.dataset.note.split(" ");
  if (draft && ids.includes(draft.id || "draft")) {
    field.focus();
    return;
  }
  const id = ids.includes(activeNoteId) ? activeNoteId : ids[0];
  const card = document.getElementById(`note-${id}`);
  if (!card) return;
  openPanel();
  activateNote(id);
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest" });
});
content.addEventListener("toggle", scheduleAnnotationLayout, true);
const annotationResize = new ResizeObserver(scheduleAnnotationLayout);
for (const target of [content, topbar, form, document.querySelector("#notes-toolbar")]) {
  annotationResize.observe(target);
}
compact.addEventListener("change", syncLayout);
collapsedOutline.addEventListener("change", syncLayout);
window.addEventListener("hashchange", () => revealAnchor());
window.addEventListener("scroll", scheduleOutline, { passive: true });
window.addEventListener("scroll", positionSelectionAction, { passive: true });
syncLayout();
if (location.hash) revealAnchor();
updateOutline();
loadNotes();
