# Paper Notes

Each paper lives in its own directory. When asked to summarize an existing paper, write or update that paper’s `study.json`. Use the [first paper’s study.json](2024.emnlp-main.929/study.json) as the format reference. Personal questions and notes belong in `annotations.json` and are edited through the reader.

## How to summarize a paper

1. Read the official English paper. Check the method, experiments, figure and table captions, limitations, and any appendix that qualifies the main result. Use `source.html` to find the corresponding section or figure ID.
2. In `claim.text`, give the paper’s main supported conclusion in one English sentence. Name the method, comparison, and evaluation scope when they matter to the conclusion.
3. Use `claim.evidence` for the strongest answer to “Why believe this?” Give each accordion item a question or finding as its title. In its body, explain the mechanism or experimental result in short paragraphs and connect it to the claim.
4. Use `sections` for the reasoning a reader needs to reconstruct the paper. Typical sections cover how the method works, what the experiment measures, and where the evidence is limited. Include relevant trade-offs and mixed results. Distinguish measured findings, the authors’ explanations, and your own interpretations.
5. For quantitative evidence, name the metric, units, evaluation split, model or baseline, and experimental conditions needed to interpret the numbers. Verify every value against its cited table or figure.
6. Write the study notes in English. Keep the original English wording in `source.html`, with the unchanged PDF alongside it.

## JSON and links

- `claim` contains `text` and `evidence`. Each `sections[]` item contains `id`, `title`, `summary`, and `evidence`.
- Every evidence item contains `id`, `title`, `body: [{ "id": "...", "text": "..." }]`, and `sources: [{ "anchor": "...", "label": "..." }]`. Use an existing `source.html` element ID as the anchor and a useful section, figure, or table label. Attach a source to each item.
- Use a lowercase slug for each ID and keep existing IDs stable. The reader combines the evidence ID and paragraph ID for saved annotations.
- Add `table: { "head": [...], "rows": [...] }` when a compact comparison helps. For a featured `figure`, use the existing asset filename, its pixel dimensions, descriptive alt text, the original figure label, a caption, and the one-based PDF page.

Before handing off, parse the JSON, confirm every anchor and figure reference exists, and open the paper in the reader. Check that the evidence opens and its links go to the cited source. When sharing a paper in the public repository, verify the publisher’s redistribution terms and include the source and license in `paper.json`.
