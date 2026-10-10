import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractText } from "../src/lib/text.ts";

const cases: [string, string | Uint8Array, string][] = [
  ["source.rtf", "{\\rtf1 Hello {\\b world}\\par Next line}", "Hello world\nNext line\n"],
  [
    "source.odt",
    zipSync({
      "content.xml": strToU8(
        "<office:document><text:h>Heading</text:h><text:p>Hello <text:span>world</text:span> &amp; friends</text:p></office:document>",
      ),
    }),
    "Heading\nHello world & friends\n",
  ],
  [
    "source.pptx",
    zipSync({
      "ppt/slides/slide10.xml": strToU8("<a:t>Last</a:t>"),
      "ppt/slides/slide2.xml": strToU8("<a:t>First &amp; second</a:t>"),
    }),
    "First & second\nLast\n",
  ],
  [
    "source.xlsx",
    zipSync({ "xl/sharedStrings.xml": strToU8("<t>Label</t>"), "xl/worksheets/sheet1.xml": strToU8("<v>42</v>") }),
    "Label\n42\n",
  ],
  [
    "source.zip",
    zipSync({
      "../outside.txt": strToU8("unsafe"),
      "notes.txt": strToU8("Hello"),
      "image.bin": new Uint8Array([1]),
      "slides.pptx": zipSync({ "ppt/slides/slide1.xml": strToU8("<a:t>Nested slide</a:t>") }),
    }),
    "Archive contents:\nimage.bin\nnotes.txt\nslides.pptx\n\n## notes.txt\n\nHello\n\n## slides.pptx\n\nNested slide\n",
  ],
  [
    "source.docx",
    zipSync({
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello &amp; world</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>',
      ),
    }),
    "Hello & world\nSecond paragraph\n",
  ],
];

for (const [name, data, expected] of cases) {
  test(`portable extraction of ${path.extname(name)}`, async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const source = path.join(directory, name);
    const destination = path.join(directory, "output.txt");
    await writeFile(source, data);
    assert.equal((await extractText(source, destination)).status, "extracted");
    assert.equal(await readFile(destination, "utf8"), expected);
  });
}

test("corrupt archives fail without creating a sidecar", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "broken.zip");
  const destination = path.join(directory, "output.txt");
  await writeFile(source, "not a zip");
  assert.equal((await extractText(source, destination)).status, "failed");
  await assert.rejects(readFile(destination));
});

test("PDF extraction reads text without an external command", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stream = "BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = ["0000000000 65535 f \n"];
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(pdf.length).padStart(10, "0")} 00000 n \n`);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = pdf.length;
  pdf += `xref\n0 6\n${offsets.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const source = path.join(directory, "source.pdf");
  const destination = path.join(directory, "output.txt");
  await writeFile(source, pdf);
  assert.equal((await extractText(source, destination)).status, "extracted");
  assert.equal(await readFile(destination, "utf8"), "Hello PDF\n");
});

test("archive expansion is bounded before decompression", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-extract-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const data = Buffer.from(zipSync({ "notes.txt": strToU8("small") }));
  const header = data.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(header > 0);
  data.writeUInt32LE(201 * 1024 * 1024, header + 24);
  const source = path.join(directory, "large.zip");
  await writeFile(source, data);
  const result = await extractText(source, path.join(directory, "output.txt"));
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /exceeds 200 MiB/);
});
