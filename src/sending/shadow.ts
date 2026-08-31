import type { Db } from "../db/port.js";
import { anexarMensagem } from "../db/repositories/messages.js";
import { registrarEvento } from "../db/repositories/events.js";
import { carregarRegrasDeSupressao } from "../db/repositories/suppression.js";
import {
  assertSendable,
  type SuppressionRule,
} from "../domain/suppression.js";
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
export function criarProvedorDeSombra(
  db: Db,
  config: {
    /**
     * Como obter as regras de supressão do tenant. Padrão: a lista do próprio
     * banco. É função e não lista porque as regras são por tenant e o provedor
     * atravessa vários.
     */
    carregarRegras?: (tenantId: string) => Promise<readonly SuppressionRule[]>;
  } = {},
): ColdEmailProvider {
  const carregarRegras =
    config.carregarRegras ??
    ((tenantId: string) => carregarRegrasDeSupressao(db, tenantId));

  return {
    modo: "shadow",

    async enviar(email: EmailParaEnviar): Promise<ResultadoDoEnvio> {
      // A mesma trava de última milha do adaptador de verdade. Vale aqui
      // porque o ensaio existe para se comportar como o envio real: se a
      // supressão vazasse na sombra, a semana de ensaio validaria um sistema
      // que não é o que vai para produção.
      assertSendable(email.email, await carregarRegras(email.tenantId));

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
