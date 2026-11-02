import {
  File,
  FileAudio,
  FileCsv,
  FileDoc,
  FileImage,
  FilePdf,
  FilePpt,
  FileText,
  FileVideo,
  FileXls,
  FileZip,
  FileCode,
  FileMd,
} from "@phosphor-icons/react";
import { extOf } from "../lib/api";

const MAP: Record<string, [any, string]> = {
  pdf: [FilePdf, "#d4483b"],
  doc: [FileDoc, "#2f6fd6"],
  docx: [FileDoc, "#2f6fd6"],
  odt: [FileDoc, "#2f6fd6"],
  xls: [FileXls, "#1f8a4c"],
  xlsx: [FileXls, "#1f8a4c"],
  ods: [FileXls, "#1f8a4c"],
  csv: [FileCsv, "#1f8a4c"],
  tsv: [FileCsv, "#1f8a4c"],
  ppt: [FilePpt, "#d2691e"],
  pptx: [FilePpt, "#d2691e"],
  png: [FileImage, "#8a5cd6"],
  jpg: [FileImage, "#8a5cd6"],
  jpeg: [FileImage, "#8a5cd6"],
  gif: [FileImage, "#8a5cd6"],
  webp: [FileImage, "#8a5cd6"],
  svg: [FileImage, "#8a5cd6"],
  avif: [FileImage, "#8a5cd6"],
  mp3: [FileAudio, "#c2410c"],
  wav: [FileAudio, "#c2410c"],
  m4a: [FileAudio, "#c2410c"],
  ogg: [FileAudio, "#c2410c"],
  mp4: [FileVideo, "#c2410c"],
  mov: [FileVideo, "#c2410c"],
  webm: [FileVideo, "#c2410c"],
  zip: [FileZip, "#7a7268"],
  md: [FileMd, "currentColor"],
  txt: [FileText, "currentColor"],
  json: [FileCode, "#7a7268"],
  js: [FileCode, "#7a7268"],
  ts: [FileCode, "#7a7268"],
  py: [FileCode, "#7a7268"],
  rs: [FileCode, "#7a7268"],
  html: [FileCode, "#7a7268"],
  css: [FileCode, "#7a7268"],
};

export function FileIcon({ path, size = 16, color = true }: { path: string; size?: number; color?: boolean }) {
  const [I, c] = MAP[extOf(path)] ?? [File, "currentColor"];
  return <I size={size} weight="duotone" color={color ? c : "currentColor"} />;
}
