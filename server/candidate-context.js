import { open } from 'node:fs/promises';
import path from 'node:path';

// The caller can only load this project file, never a client-supplied path.
export async function readCandidateContext(projectRoot) {
  let file;
  try {
    file = await open(path.join(projectRoot, 'contexto.md'), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 24000) {
      return { status: 400, error: 'O contexto.md deve ser um arquivo de texto com até 6.000 caracteres.' };
    }
    const buffer = Buffer.alloc(24001);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').trim();
    if (bytesRead > 24000 || text.length > 6000) {
      return { status: 400, error: 'O contexto.md ultrapassa o limite de 6.000 caracteres. Reduza o texto e tente novamente.' };
    }
    if (!text) return { status: 400, error: 'O contexto.md está vazio. Escreva seu contexto no arquivo ou crie um do zero.' };
    return { status: 200, text };
  } catch (error) {
    return error.code === 'ENOENT'
      ? { status: 404, error: 'contexto.md não encontrado na pasta do projeto. Você pode criar um contexto do zero.' }
      : { status: 500, error: 'Não foi possível ler o contexto.md. Verifique as permissões do arquivo.' };
  } finally {
    await file?.close();
  }
}
