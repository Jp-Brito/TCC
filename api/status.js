// GET /api/status
// Confere se o token está configurado e se a Olho Vivo aceita o login.
// Também mede o tempo do login (útil para os testes técnicos do TCC).
import { testarLogin, enviarJson, tratarErro, exigirGet } from "../lib/olhovivo.js";

export default async function handler(req, res) {
  if (!exigirGet(req, res)) return;
  try {
    const inicio = Date.now();
    await testarLogin();
    enviarJson(res, 200, { ok: true, loginMs: Date.now() - inicio });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
