import type { Db } from "../db/port.js";
import { anexarMensagem } from "../db/repositories/messages.js";
import { registrarEvento } from "../db/repositories/events.js";
import type {
  ColdEmailProvider,
  EmailParaEnviar,
  ResultadoDoEnvio,
} from "./types.js";

/**
 * Provedor que não envia nada.
 *
 * Grava exatamente a mesma linha em `messages` que um envio real gravaria, mas
 * com `shadow = true`, e não chama fornecedor nenhum. É o que permite rodar a
 * semana de ensaio do spec §6 com o sistema inteiro se comportando normalmente
 * — o único jeito de o ensaio significar alguma coisa.
 *
 * O Instantly não tem sandbox, então "não chamar" é literalmente a única forma
 * de garantir que nenhum estranho receba e-mail durante o ensaio.
 */
export function criarProvedorDeSombra(db: Db): ColdEmailProvider {
  return {
    modo: "shadow",

    async enviar(email: EmailParaEnviar): Promise<ResultadoDoEnvio> {
      await anexarMensagem(db, {
        tenantId: email.tenantId,
        leadId: email.leadId,
        direction: "outbound",
        subject: email.assunto,
        body: email.corpo,
        shadow: true,
      });

      await registrarEvento(db, {
        tenantId: email.tenantId,
        leadId: email.leadId,
        kind: "envio_em_sombra",
        payload: { destinatario: email.email, assunto: email.assunto },
      });

      return { enviado: true, externalId: null, sombra: true };
    },

    async contarBounces(): Promise<null> {
      // Nada saiu, então não há bounce que a sombra possa relatar.
      return null;
    },
  };
}
