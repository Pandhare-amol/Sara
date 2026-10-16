import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import pptxgen from "pptxgenjs";

export type OfficeFormat = "docx" | "xlsx" | "pptx";
const XML = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
function boundedText(input: string, limit = 16_000): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input)) {
    throw new Error("Office export requires bounded printable text.");
  }
  return input.replace(/\r\n/g, "\n");
}
function parseCsv(input: string): string[][] {
  boundedText(input, 200_000);
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false, justClosed = false;
  const append = () => {
    if (value.length > 1_000 || /^[\s]*[=+@-]/.test(value)) throw new Error("Unsafe or oversized CSV cell; spreadsheet formulas are not exported.");
    row.push(value); value = "";
    if (row.length > 30) throw new Error("Spreadsheet columns exceed the 30-column budget.");
  };
  const finish = () => { append(); if (rows.length >= 500) throw new Error("Spreadsheet rows exceed the 500-row budget.");
    rows.push(row); row = []; };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) { if (char === '"' && input[index + 1] === '"') { value += '"'; index++; }
      else if (char === '"') { quoted = false; justClosed = true; } else value += char; }
    else if (justClosed) { if (char === ",") { append(); justClosed = false; }
      else if (char === "\n") { finish(); justClosed = false; }
      else if (char === "\r" && input[index + 1] === "\n") { finish(); justClosed = false; index++; }
      else throw new Error("CSV has characters after a closing quote."); }
    else if (char === '"') { if (value) throw new Error("CSV quotes must begin at a cell boundary."); quoted = true; }
    else if (char === ",") append();
    else if (char === "\n") finish();
    else if (char === "\r" && input[index + 1] === "\n") { finish(); index++; }
    else value += char;
    if (rows.length > 500 || row.length > 30) throw new Error("Spreadsheet size exceeded.");
  }
  if (quoted) throw new Error("CSV has an unclosed quoted field.");
  if (value || row.length || justClosed) finish();
  if (rows.length < 2 || rows.some((r) => r.length !== rows[0].length)) {
    throw new Error("CSV requires a header and equal-width rows.");
  }
  return rows;
}
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function spreadsheetColumn(index: number): string { let answer = "";
  for (let number = index + 1; number; number = Math.floor((number - 1) / 26)) {
    answer = String.fromCharCode(65 + (number - 1) % 26) + answer;
  } return answer;
}
async function createXlsx(input: string): Promise<Buffer> {
  const rows = parseCsv(input);
  const sheetData = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) =>
    `<c r="${spreadsheetColumn(column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${XML(value)}</t></is></c>`).join("")}</row>`).join("");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${S}"><sheetData>${sheetData}</sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
async function createDocx(input: string): Promise<Buffer> {
  const text = boundedText(input);
  const paragraphs = text.split("\n").map((line) => {
    const match = line.match(/^(#{1,2})\s+(.+)$/);
    return new Paragraph(match ? { text: match[2], heading: match[1].length === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2 }
      : { text: line });
  });
  const doc = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}
async function createPptx(input: string): Promise<Buffer> {
  const text = boundedText(input);
  const sections = text.split(/^#{1,2}\s+(.+)$/gm);
  const slides: Array<{ title: string; body: string }> = [];
  if (sections[0]?.trim()) slides.push({ title: "SARA draft", body: sections[0].trim() });
  for (let index = 1; index < sections.length; index += 2) {
    slides.push({ title: (sections[index] || "Untitled scene").trim(), body: (sections[index + 1] || "").trim() });
  }
  if (!slides.length || slides.length > 20 || slides.some((slide) => slide.title.length > 100 || slide.body.length > 900)) {
    throw new Error("Presentation needs 1–20 concise text-only slides (up to 900 characters each).");
  }
  const deck = new pptxgen(); deck.layout = "LAYOUT_WIDE";
  deck.author = "SARA local export"; deck.subject = "Unverified draft requiring review";
  for (const entry of slides) {
    const slide = deck.addSlide(); slide.background = { color: "111827" };
    slide.addText(entry.title, { x: 0.7, y: 0.7, w: 11.8, h: 0.9, fontSize: 27, bold: true, color: "E5E7EB", breakLine: false });
    slide.addText(entry.body || " ", { x: 0.8, y: 1.8, w: 11.6, h: 4.9, fontSize: 16, color: "D1D5DB", valign: "top", breakLine: false });
  }
  const packed = await deck.write({ outputType: "nodebuffer" });
  if (!Buffer.isBuffer(packed)) throw new Error("PowerPoint exporter did not return a complete file.");
  return packed;
}

/** CRC/required OPC parts/content checks are independent of the exporter.
 * Native Office layout and editing are not asserted without a Windows/Office test. */
export async function inspectOfficeExport(bytes: Buffer, format: OfficeFormat): Promise<{ entries: number; detail: string }> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 500 || bytes.length > 5_000_000 || bytes.subarray(0, 4).toString("hex") !== "504b0304") {
    throw new Error("Office artifact is not a bounded ZIP package.");
  }
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const required = format === "docx" ? ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]
    : format === "xlsx" ? ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]
      : ["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/slides/slide1.xml"];
  if (required.some((file) => !zip.file(file))) throw new Error("Office file is missing mandatory package parts.");
  const paths = Object.keys(zip.files);
  if (paths.length > 150 || paths.some((file) => file.includes("..") || /\.(?:bin|vba)$/i.test(file))) {
    throw new Error("Unexpected external or macro-enabled Office package parts.");
  }
  for (const file of paths.filter((name) => name.endsWith(".rels"))) {
    const rels = await zip.file(file)?.async("string");
    if (rels && /TargetMode\s*=\s*["']External["']/i.test(rels)) throw new Error("External Office relationships are not permitted.");
  }
  const main = await zip.file(required.at(-1)!)!.async("string");
  const hasData = format === "docx" ? /<w:t\b/.test(main) : format === "xlsx" ? /<c\s/.test(main) : /<a:t\b/.test(main);
  if (!hasData) throw new Error("Office document contains no expected content.");
  return { entries: paths.length, detail: `${format} CRC and required internal text parts` };
}
export async function createOfficeExport(format: OfficeFormat, source: string): Promise<Buffer> {
  const output = format === "docx" ? await createDocx(source) : format === "xlsx" ? await createXlsx(source) : await createPptx(source);
  await inspectOfficeExport(output, format);
  return output;
}
