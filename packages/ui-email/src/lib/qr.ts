import { Buffer } from "node:buffer";
import QRCode from "qrcode-generator";

export type CreateQrDataUrlOptions = {
  /**
   * Size multiplier for each QR cell. Higher numbers produce larger images.
   */
  cellSize?: number;
  /**
   * Margin around the QR code, expressed in multiples of cell size.
   */
  margin?: number;
};

const defaultOptions: Required<CreateQrDataUrlOptions> = {
  cellSize: 8,
  margin: 2,
};

export const createQrDataUrl = (
  value: string,
  options?: CreateQrDataUrlOptions,
): string => {
  const { cellSize, margin } = { ...defaultOptions, ...options };
  const qr = QRCode(0, "M");
  qr.addData(value);
  qr.make();

  const svg = qr.createSvgTag({
    cellSize,
    margin,
    scalable: true,
  });

  const base64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
};
