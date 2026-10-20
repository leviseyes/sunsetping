/**
 * Builds public/downloads/sunset-cheat-sheet.pdf — a two-page field card.
 * Run: node scripts/build-cheat-sheet.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../public/downloads/sunset-cheat-sheet.pdf");

const INK = "0.110 0.086 0.071";
const MUTED = "0.435 0.396 0.365";
const EMBER = "0.769 0.329 0.102";
const PAPER = "0.996 0.988 0.973";
const CREAM = "0.953 0.933 0.906";

function pdfEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function block(ops, { font, size, x, y, lines, color = INK, leading }) {
  const lead = leading || size + 5;
  ops.push(`${color} rg`);
  ops.push("BT");
  ops.push(`/${font} ${size} Tf`);
  ops.push(`${lead} TL`);
  ops.push(`${x} ${y} Td`);
  lines.forEach((line, index) => {
    if (index) ops.push("T*");
    ops.push(`(${pdfEscape(line)}) Tj`);
  });
  ops.push("ET");
  return y - lead * Math.max(lines.length - 1, 0);
}

function section(ops, y, title, paragraphs, width) {
  y = block(ops, { font: "F4", size: 12, x: 54, y, lines: [title], color: EMBER, leading: 16 });
  y -= 16;
  for (const paragraph of paragraphs) {
    const lines = wrap(paragraph, width);
    y = block(ops, { font: "F1", size: 11, x: 54, y, lines, leading: 15 });
    y -= 20;
  }
  return y;
}

function pageShell(ops, pageLabel) {
  ops.push(`${CREAM} rg`);
  ops.push("0 0 612 792 re f");
  ops.push(`${INK} rg`);
  ops.push("0 734 612 58 re f");
  ops.push(`${EMBER} rg`);
  ops.push("0 730 612 4 re f");
  block(ops, { font: "F3", size: 9, x: 54, y: 772, lines: ["SUNSETPING"], color: "0.820 0.780 0.730", leading: 11 });
  block(ops, { font: "F2", size: 20, x: 54, y: 750, lines: ["Sunset shooting cheat sheet"], color: "1 1 1", leading: 22 });
  block(ops, { font: "F3", size: 9, x: 54, y: 36, lines: [`${pageLabel}   sunsetping.com   free with your signup`], color: MUTED, leading: 12 });
}

function pageOne() {
  const ops = [];
  pageShell(ops, "1 / 2");
  let y = 700;
  y = block(ops, {
    font: "F1",
    size: 12,
    x: 54,
    y,
    lines: wrap("A field card for landscape photographers. SunsetPing scores the sky from 1 to 10. This sheet is how to shoot the hour it points you toward.", 86),
    leading: 16,
  });
  y -= 26;
  y = section(ops, y, "HOW TO READ THE SCORE", [
    "8 to 10 means don't miss it. The drive is worth it. 6 or 7 is worth stepping outside. 4 or 5 is a quick peek if you are already nearby. 3 or below means stay home. The sky will not pay for the trip.",
    "The score uses the hour around sunset: low cloud, mid cloud, and high cloud, plus humidity, visibility, and rain. Enough broken cloud to catch color scores higher. A thick low blanket, a downpour, or a completely clear sky scores lower.",
  ], 88);
  y = section(ops, y, "CLOUDS THAT LIGHT UP", [
    "Mid and high clouds at about 30 to 70 percent cover are the canvas. That is the range that takes the color. Low cloud over about 60 percent blocks the horizon, so skip the drive even if the score is close.",
    "A clear sky, under about 10 percent mid and high cloud, is pretty and plain. There is nothing for the light to catch, and the score caps at 6. Rain or poor visibility pulls the score down when the high clouds still look promising.",
  ], 88);
  y = section(ops, y, "GOLDEN HOUR", [
    "Golden hour is the sun from about +6 degrees down to the horizon. Shoot manual, RAW, ISO 100 to 200. Start near f/8 to f/11 and 1/60 to 1/250. White balance can stay on daylight. Expose for the sky and lift the foreground later. Use a lens hood if you are aimed at the sun.",
  ], 88);
  y = section(ops, y, "SUNSET", [
    "When the sun sits on the horizon, bracket one stop under and one stop over. Meter the sky beside the disc, not the disc itself. f/11 to f/16 draws a sunstar from a small aperture. Keep the horizon level. A crooked sea is the first thing a viewer notices.",
  ], 88);
  if (y < 56) console.error("cheat sheet page 1 overflows", y);
  return ops.join("\n");
}

function pageTwo() {
  const ops = [];
  pageShell(ops, "2 / 2");
  let y = 700;
  y = section(ops, y, "BLUE HOUR", [
    "Blue hour is the sun from about -4 degrees to about -8 degrees, after sunset and before the sky goes black. Put the camera on a tripod. Shutter from about 1 second to 15 seconds, ISO 100 to 400, f/8 to f/11. A 2-second timer keeps your hand off the camera.",
    "White balance toward 7000 to 8000K holds the blue if you want it blue. City lights balance the sky, so arrive before those highlights clip. The same window in the morning sits before sunrise.",
  ], 88);
  y = section(ops, y, "COMPOSITION", [
    "Put the horizon on the lower third when the sky is the subject, and on the upper third when the land is. Give the frame a foreground: a rock, a pier, a reflection, or a road that leads in.",
    "Face the sun for color in the clouds. Turn around for front-lit land. Show up at golden hour start and stay through blue hour end. Leave space in the direction the light is moving.",
  ], 88);
  y = section(ops, y, "GEAR CHECKLIST", [
    "Camera and a wide lens, about 16 to 35mm full-frame equivalent. A sturdy tripod and a ball head. A spare battery, because cold evenings drain them. A lens cloth for spray, dust, and fingerprints. A headlamp with a red mode so you keep your night vision. And the SunsetPing alert, so you do not drive out for a 3.",
  ], 88);
  if (y < 170) console.error("cheat sheet page 2 overlaps the closing note", y);
  const boxTop = 148;
  ops.push(`${PAPER} rg`);
  ops.push(`54 ${boxTop - 78} 504 78 re f`);
  ops.push(`${EMBER} rg`);
  ops.push(`54 ${boxTop - 78} 4 78 re f`);
  block(ops, {
    font: "F2",
    size: 13,
    x: 70,
    y: boxTop - 22,
    lines: ["Before you drive"],
    leading: 16,
  });
  block(ops, {
    font: "F1",
    size: 11,
    x: 70,
    y: boxTop - 42,
    lines: wrap("Check tonight's score on the city page. It stays public. The 7-day quality outlook, golden hour, and blue hour times arrive by email after you sign up.", 78),
    leading: 14,
  });
  return ops.join("\n");
}

function buildPdf(streams) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add("<< /Type /Pages /Kids [] /Count 0 >>");
  if (catalogId !== 1 || pagesId !== 2) throw new Error("catalog layout");
  const fonts = {
    F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>"),
    F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>"),
    F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    F4: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"),
  };
  const fontRes = Object.entries(fonts).map(([name, id]) => `/${name} ${id} 0 R`).join(" ");
  const pageIds = streams.map((stream) => {
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << ${fontRes} >> >> >>`);
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buildPdf([pageOne(), pageTwo()]));
console.log(OUT);
