/*
  Minimal local ESC/POS print bridge for patient tickets.

  Run on the Windows registration workstation or any machine that can reach
  the printer IP on TCP port 9100.

  Logo support:
    - Install dependency: npm install pngjs
    - Place a monochrome PNG at: ./assets/logo-ticket.png
    - Recommended logo width for 58mm tickets: roughly 200-300 px
*/

const express = require("express");
const cors = require("cors");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
require("dotenv").config();

const app = express();

const PRINT_SERVER_PORT = Number(process.env.PRINT_SERVER_PORT || 3333);
const PRINTER_HOST = process.env.PRINTER_HOST;
const PRINTER_PORT = Number(process.env.PRINTER_PORT || 9100);

app.use(cors({ origin: true }));
app.use(express.json({ limit: "128kb" }));

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

const bytes = (...items) => Buffer.from(items);
const text = (value = "") => Buffer.from(String(value), "latin1");
const line = (value = "") => Buffer.concat([text(value), bytes(LF)]);

const initialize = () => bytes(ESC, 0x40);
const alignLeft = () => bytes(ESC, 0x61, 0x00);
const alignCenter = () => bytes(ESC, 0x61, 0x01);
const boldOn = () => bytes(ESC, 0x45, 0x01);
const boldOff = () => bytes(ESC, 0x45, 0x00);
const sizeNormal = () => bytes(GS, 0x21, 0x00);
const sizeDoubleHeight = () => bytes(GS, 0x21, 0x01);
const sizeDoubleWidthHeight = () => bytes(GS, 0x21, 0x11);

const feedAndCut = () =>
  bytes(
    ESC,
    0x64,
    0x04, // ESC d 4: feed 4 lines before cutting
    GS,
    0x56,
    0x00, // GS V 0: full cut
  );

const horizontalRule = () => line("________________________");

const LOGO_MAX_WIDTH_DOTS = Number(process.env.LOGO_MAX_WIDTH_DOTS || 420);
const PRINTER_WIDTH_DOTS = Number(process.env.PRINTER_WIDTH_DOTS || 384);

const isPixelBlack = (png, x, y) => {
  const idx = (png.width * y + x) << 2;
  const r = png.data[idx];
  const g = png.data[idx + 1];
  const b = png.data[idx + 2];
  const a = png.data[idx + 3];

  if (a <= 127) return false;

  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance < 180;
};

const resizePngNearest = (png, maxWidth) => {
  if (png.width <= maxWidth) return png;

  const scale = maxWidth / png.width;
  const resizedWidth = Math.max(1, Math.floor(png.width * scale));
  const resizedHeight = Math.max(1, Math.floor(png.height * scale));
  const resized = new PNG({ width: resizedWidth, height: resizedHeight });

  for (let y = 0; y < resizedHeight; y += 1) {
    for (let x = 0; x < resizedWidth; x += 1) {
      const sourceX = Math.min(png.width - 1, Math.floor(x / scale));
      const sourceY = Math.min(png.height - 1, Math.floor(y / scale));
      const sourceIdx = (png.width * sourceY + sourceX) << 2;
      const targetIdx = (resizedWidth * y + x) << 2;

      resized.data[targetIdx] = png.data[sourceIdx];
      resized.data[targetIdx + 1] = png.data[sourceIdx + 1];
      resized.data[targetIdx + 2] = png.data[sourceIdx + 2];
      resized.data[targetIdx + 3] = png.data[sourceIdx + 3];
    }
  }

  return resized;
};

const bitImageLogo = (pngPath) => {
  if (!fs.existsSync(pngPath)) return Buffer.alloc(0);

  const originalPng = PNG.sync.read(fs.readFileSync(pngPath));
  const png = resizePngNearest(originalPng, LOGO_MAX_WIDTH_DOTS);

  const width = png.width;
  const height = png.height;

  /*
    ESC * 33 prints in 24-dot vertical bands.

    Two details matter a lot:
      1. Set line spacing to exactly 24 dots while printing image bands.
         Otherwise the printer advances more than the image band height,
         creating a white horizontal line through the logo.
      2. Center by adding blank dot-columns to the image data itself.
         Do not print leading text spaces before a bit-image command.
  */

  const leftPaddingDots = Math.max(
    0,
    Math.floor((PRINTER_WIDTH_DOTS - width) / 2),
  );
  const rightPaddingDots = Math.max(
    0,
    PRINTER_WIDTH_DOTS - width - leftPaddingDots,
  );
  const printedWidth = width + leftPaddingDots + rightPaddingDots;
  const nL = printedWidth & 0xff;
  const nH = (printedWidth >> 8) & 0xff;

  const chunks = [];

  // ESC 3 n: set line spacing to n dots.
  chunks.push(bytes(ESC, 0x33, 24));

  for (let y = 0; y < height; y += 24) {
    chunks.push(bytes(ESC, 0x2a, 0x21, nL, nH));

    for (let x = -leftPaddingDots; x < width + rightPaddingDots; x += 1) {
      for (let k = 0; k < 3; k += 1) {
        let byte = 0;

        for (let bit = 0; bit < 8; bit += 1) {
          const py = y + k * 8 + bit;

          if (x >= 0 && x < width && py < height && isPixelBlack(png, x, py)) {
            byte |= 0x80 >> bit;
          }
        }

        chunks.push(bytes(byte));
      }
    }

    chunks.push(bytes(LF));
  }

  // ESC 2: restore default line spacing.
  chunks.push(bytes(ESC, 0x32));

  return Buffer.concat(chunks);
};

const removeAccents = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const clean = (value = "") =>
  removeAccents(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const wrapText = (value = "", width = 32) => {
  const words = clean(value).split(" ").filter(Boolean);
  const lines = [];
  let current = "";

  words.forEach((word) => {
    if (!current) {
      current = word;
      return;
    }

    if (`${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  });

  if (current) lines.push(current);
  return lines.length ? lines : [""];
};

const formatDateTime = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";

  const datePart = date.toLocaleDateString("es-GT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const timePart = date.toLocaleTimeString("es-GT", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `${datePart} ${timePart}`;
};

const qrCode = (value = "") => {
  const data = Buffer.from(String(value), "ascii");
  const storeLength = data.length + 3;
  const pL = storeLength & 0xff;
  const pH = (storeLength >> 8) & 0xff;

  return Buffer.concat([
    // Model 2
    bytes(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00),
    // Module size
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06),
    // Error correction M
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31),
    // Store data
    bytes(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30),
    data,
    // Print QR
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
  ]);
};

const buildPatientTicket = (patient = {}) => {
  const chunks = [];
  const logoPath = path.join(__dirname, "assets", "logo-ticket.png");

  const locationName = clean(patient.location_name || "Clinica");
  const patientName = clean(patient.patient_name || "");
  const guardianName = clean(patient.guardian_name || "");
  const organization = clean(patient.organization || "");
  const visitType = clean(patient.visit_type_label || patient.type_of_visit || "");
  const ptNo = clean(patient.pt_no || "");
  const locationMessage = clean(patient.location_message || "");
  const dateTime = formatDateTime(patient.created_at);

  chunks.push(initialize());
  chunks.push(alignCenter());

  chunks.push(bitImageLogo(logoPath));
  chunks.push(line(""));

  chunks.push(boldOn());
  wrapText(locationName, 24).forEach((wrappedLine) =>
    chunks.push(line(wrappedLine)),
  );
  chunks.push(sizeNormal(), boldOff());
  chunks.push(horizontalRule());

  chunks.push(line(""));
  chunks.push(alignCenter());
  chunks.push(boldOn(), sizeDoubleWidthHeight());
  wrapText(patientName, 16).forEach((wrappedLine) =>
    chunks.push(line(wrappedLine)),
  );
  chunks.push(sizeNormal(), boldOff());
  chunks.push(line(""));

if (guardianName && patient.age_group === "child") {
  chunks.push(line(""));
  chunks.push(boldOn(), line("Responsable:"), boldOff());
  wrapText(guardianName, 48).forEach((wrappedLine) =>
    chunks.push(line(wrappedLine)),
  );
}

if (organization) {
  chunks.push(line(""));
  chunks.push(boldOn(), line("Organización:"), boldOff());

  wrapText(organization, 48).forEach((wrappedLine) =>
    chunks.push(line(wrappedLine)),
  );
}

  chunks.push(line(""));
  chunks.push(alignCenter());
  chunks.push(line(visitType));
  chunks.push(line(dateTime));
  chunks.push(horizontalRule());

  chunks.push(alignCenter());
  chunks.push(line(""));
  chunks.push(qrCode(ptNo));
  chunks.push(line(""));


  wrapText("Presente este ticket en cada estación.", 32).forEach(
    (wrappedLine) => chunks.push(line(wrappedLine)),
  );

  if (locationMessage) {
    chunks.push(line(""));
    chunks.push(horizontalRule());
    chunks.push(line(""));
    chunks.push(alignLeft());

    wrapText(locationMessage, 45).forEach((wrappedLine) =>
      chunks.push(line(wrappedLine)),
    );
  }

  chunks.push(line(""));
  chunks.push(feedAndCut());

  return Buffer.concat(chunks);
};

const sendToPrinter = (payload) =>
  new Promise((resolve, reject) => {
    if (!PRINTER_HOST) {
      reject(new Error("PRINTER_HOST is not configured."));
      return;
    }

    const socket = new net.Socket();
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    const fail = (error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(error);
      }
    };

    socket.setTimeout(10000);
    socket.once("timeout", () => fail(new Error("Printer socket timeout.")));
    socket.once("error", fail);

    socket.connect(PRINTER_PORT, PRINTER_HOST, () => {
      const canContinue = socket.write(payload);

      const closeAfterDrain = () => {
        socket.end(() => finish());
      };

      if (canContinue) {
        closeAfterDrain();
      } else {
        socket.once("drain", closeAfterDrain);
      }
    });
  });

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    printer_host_configured: Boolean(PRINTER_HOST),
    printer_host: PRINTER_HOST || null,
    printer_port: PRINTER_PORT,
  });
});

app.post("/print/patient-ticket", async (req, res) => {
  try {

     console.log(
    `[${new Date().toISOString()}] PRINT REQUEST RECEIVED`,
  );

    console.log(JSON.stringify(req.body.pt_no, null, 2));
    
    
    const patient = req.body?.patient;

    if (!patient?.pt_no) {
      res.status(400).json({ ok: false, error: "patient.pt_no is required." });
      return;
    }

    const payload = buildPatientTicket(patient);
    await sendToPrinter(payload);

    res.json({ ok: true, bytes_sent: payload.length });
  } catch (error) {
    console.error("Print failed:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PRINT_SERVER_PORT, () => {
  console.log(
    `ESC/POS print bridge listening on http://192.168.2.48:${PRINT_SERVER_PORT}`,
  );
  console.log(`Target printer: ${PRINTER_HOST || "<not configured>"}:${PRINTER_PORT}`);
});
