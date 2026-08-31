import type { NovoLead } from "../db/repositories/leads.js";
import type { CandidatoDecisor } from "./types.js";

/**
 * Traduz o candidato que a cadeia achou na linha de lead que o banco espera.
 *
 * Mora num arquivo próprio, e não em `chain.ts`, porque a cadeia hoje não sabe
 * que existe banco: puxar `NovoLead` para dentro dela inverteria a dependência
 * e faria o enriquecimento depender da persistência. Este adaptador conhece os
 * dois lados; nenhum dos dois precisa conhecê-lo.
 */
export function paraNovoLead(
  candidato: CandidatoDecisor,
  ids: { tenantId: string; campaignId: string; companyId: string },
): NovoLead {
  if (!candidato.email) {
    throw new Error(
      `Candidato da fonte ${candidato.fonte} não tem e-mail: não dá para ` +
        `criar um lead sem endereço para contatar.`,
    );
  }

  return {
    tenantId: ids.tenantId,
    campaignId: ids.campaignId,
    companyId: ids.companyId,
    fullName: candidato.nome,
    roleTitle: candidato.cargo,
    email: candidato.email,
    // Só `valid` conta como verificado. `accept_all` é aceito pela cadeia de
    // propósito — o domínio responde "sim" a qualquer endereço, então não é
    // reprovação, é indeterminação —, mas indeterminado não ganha lugar na
    // fila de envio: `listarProntosParaContato` filtra por
    // `email_verified = true`, e um accept_all é justamente o endereço com
    // maior chance de voltar como bounce. Ele entra como candidato e espera.
    emailVerified: candidato.verificacao === "valid",
  };
}
