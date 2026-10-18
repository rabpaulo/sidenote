import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Images attached to a chat turn travel as [{ mimeType, data }] with base64 data.
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MAX_IMAGES = 4;
const MAX_BASE64_LENGTH = 12 * 1024 * 1024;
const FILE_TTL_MS = 60 * 60 * 1000;

export const SCREENSHOT_PROMPT = 'A imagem anexada é uma captura da minha tela. Identifique a pergunta ou o problema mostrado '
  + '(por exemplo, um exercício de LeetCode com enunciado, exemplos e restrições) e resolva. '
  + 'Se houver um editor com a assinatura da função, mantenha os mesmos nomes de função e parâmetros, '
  + 'escritos na linguagem da resposta.';

export function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter((image) => EXTENSIONS[image?.mimeType] && typeof image.data === 'string'
      && image.data.length > 0 && image.data.length <= MAX_BASE64_LENGTH && /^[A-Za-z0-9+/]+=*$/.test(image.data))
    .slice(0, MAX_IMAGES)
    .map(({ mimeType, data }) => ({ mimeType, data }));
}

export const imageDataUrl = ({ mimeType, data }) => `data:${mimeType};base64,${data}`;

/** For CLIs without inline image input: saves the images and returns their paths. */
export function writeImageFiles(images, dir = path.join(os.tmpdir(), 'interviewai-screenshots')) {
  if (!images.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > FILE_TTL_MS) fs.rmSync(file); } catch {}
  }
  return images.map((image) => {
    const file = path.join(dir, `${randomUUID()}.${EXTENSIONS[image.mimeType]}`);
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
    return file;
  });
}

export function promptWithImageFiles(prompt, files) {
  if (!files.length) return prompt;
  return `IMAGENS ANEXADAS: abra cada arquivo abaixo com sua ferramenta de leitura de arquivos e analise o conteúdo antes de responder.\n${files.map((file) => `- ${file}`).join('\n')}\n\n${prompt}`;
}
