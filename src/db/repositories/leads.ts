import type { Db } from "../port.js";
import { LEAD_STAGES, type Lead, type LeadStage } from "../types.js";
import { assertTransition } from "../../domain/stages.js";

export interface NovoLead {
  tenantId: string;
  campaignId: string;
  companyId: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string;
  emailVerified: boolean;
}

export interface ExtrasDaTransicao {
  discardReason?: string;
  handoffReason?: string;
  needsHuman?: boolean;
  resumeAt?: Date;
}

const COLUNAS = `id, tenant_id, campaign_id, company_id, full_name, role_title,
  email, email_verified, stage, discard_reason, handoff_reason, exchange_count,
  resume_at, needs_human, bounced_at, created_at, updated_at`;

/**
 * Cria o lead exigindo que a empresa seja do mesmo tenant.
 *
 * `tenant_id` e `company_id` são chaves estrangeiras independentes: o esquema
 * aceitaria de bom grado um lead do tenant A apontando para uma empresa do
 * tenant B. As leituras filtram por tenant e não veriam a linha, então o
 * estrago seria dado invisível — dado órfão hoje, vazamento no dia em que
 * alguma consulta juntar por `company_id`. O `where exists` faz o próprio
 * banco recusar a combinação, sem transação e sem uma segunda ida ao servidor.
 */
export async function criarLead(db: Db, input: NovoLead): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `insert into leads
       (tenant_id, campaign_id, company_id, full_name, role_title,
        email, email_verified)
     select $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
            $7::boolean
     where exists (
       select 1 from companies where id = $3 and tenant_id = $1
     )
     returning ${COLUNAS}`,
    [
      input.tenantId,
      input.campaignId,
      input.companyId,
      input.fullName,
      input.roleTitle,
      input.email,
      input.emailVerified,
    ],
  );
  if (!rows[0]) {
    throw new Error(
      `Empresa ${input.companyId} não pertence ao tenant ${input.tenantId}: ` +
        `um lead não pode cruzar tenants.`,
    );
  }
  return rows[0];
}

export async function buscarLead(
  db: Db,
  tenantId: string,
  id: string,
): Promise<Lead | null> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/**
 * Move o lead de estágio, validando a transição antes de escrever.
 *
 * A validação usa a mesma máquina de estados do domínio (`assertTransition`),
 * então o banco nunca guarda um caminho que o funil não permite — e o lead
 * fica intacto quando a transição é recusada.
 *
 * O UPDATE é condicionado ao estágio que acabou de ser lido e validado
 * (compare-and-swap). Sem isso, ler-validar-escrever é uma corrida: um webhook
 * de resposta e a varredura de follow-up podem ler `enriched` ao mesmo tempo,
 * ambos aprovar, e ambos escrever — deixando o lead num estágio que o funil
 * nunca autorizou. É exatamente o instante em que os leads com `resume_at`
 * vencido acordam. Zero linhas de volta significa que outro fluxo moveu o lead
 * primeiro; lançamos, e quem chamou decide se relê e tenta de novo.
 *
 * O teste não enxerga essa corrida por construção: o PGlite é uma única
 * conexão serializada, enquanto o `pg.Pool` distribui cinco.
 */
export async function transicionarLead(
  db: Db,
  tenantId: string,
  id: string,
  para: LeadStage,
  extras: ExtrasDaTransicao = {},
): Promise<Lead> {
  const atual = await buscarLead(db, tenantId, id);
  if (!atual) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }

  assertTransition(atual.stage, para);

  const { rows } = await db.query<Lead>(
    `update leads set
       stage = $3,
       discard_reason = coalesce($4, discard_reason),
       handoff_reason = coalesce($5, handoff_reason),
       needs_human = coalesce($6, needs_human),
       resume_at = coalesce($7, resume_at)
     where tenant_id = $1 and id = $2 and stage = $8
     returning ${COLUNAS}`,
    [
      tenantId,
      id,
      para,
      extras.discardReason ?? null,
      extras.handoffReason ?? null,
      extras.needsHuman ?? null,
      extras.resumeAt ?? null,
      atual.stage,
    ],
  );
  if (!rows[0]) {
    throw new Error(
      `Lead ${id} mudou de estágio ao mesmo tempo: esperava ${atual.stage} ` +
        `para aplicar ${atual.stage} -> ${para}, mas outro fluxo moveu antes.`,
    );
  }
  return rows[0];
}

export interface CamposParaAtualizar {
  needsHuman?: boolean;
  handoffReason?: string;
  resumeAt?: Date;
}

/**
 * Atualiza campos do lead sem mudar de estágio.
 *
 * `transicionarLead` exige uma transição válida — inclusive recusa
 * autotransição — mas repassar a um humano, agendar uma retomada futura, ou
 * simplesmente responder a uma dúvida não move o lead de `in_conversation`.
 * Forçar essas mudanças por `transicionarLead` exigiria um estágio de
 * destino igual ao de origem, que a máquina de estados recusa de propósito.
 */
export async function atualizarLead(
  db: Db,
  tenantId: string,
  id: string,
  campos: CamposParaAtualizar,
): Promise<Lead> {
  const { rows } = await db.query<Lead>(
    `update leads set
       needs_human = coalesce($3, needs_human),
       handoff_reason = coalesce($4, handoff_reason),
       resume_at = coalesce($5, resume_at)
     where tenant_id = $1 and id = $2
     returning ${COLUNAS}`,
    [
      tenantId,
      id,
      campos.needsHuman ?? null,
      campos.handoffReason ?? null,
      campos.resumeAt ?? null,
    ],
  );
  if (!rows[0]) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }
  return rows[0];
}

export async function incrementarTrocas(
  db: Db,
  tenantId: string,
  id: string,
): Promise<number> {
  const { rows } = await db.query<{ exchange_count: number }>(
    `update leads set exchange_count = exchange_count + 1
     where tenant_id = $1 and id = $2
     returning exchange_count`,
    [tenantId, id],
  );
  if (!rows[0]) {
    throw new Error(`Lead ${id} não encontrado no tenant ${tenantId}.`);
  }
  return rows[0].exchange_count;
}

/** Leads prontos para o primeiro contato: enriquecidos e com e-mail verificado. */
export async function listarProntosParaContato(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads
     where tenant_id = $1 and campaign_id = $2
       and stage = 'enriched' and email_verified = true
     order by created_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}

/**
 * Leads que disseram "não agora" e cujo prazo combinado já venceu.
 *
 * `needs_human = false` porque um repasse a humano, mesmo com `resume_at`
 * ainda gravado de uma rodada anterior, não deve ser retomado pela
 * automação sozinha — a mesma trava que `decideNextAction` já aplica a
 * qualquer resposta nova.
 */
export async function listarProntosParaRetomar(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<Lead[]> {
  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads
     where tenant_id = $1 and campaign_id = $2
       and stage = 'in_conversation' and needs_human = false
       and resume_at is not null and resume_at <= now()
     order by resume_at
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}

/**
 * Zera `resume_at` depois que o follow-up agendado foi enviado.
 *
 * Função à parte de `atualizarLead`: lá, `resume_at = coalesce($5,
 * resume_at)` nunca consegue voltar a `null` — é assim que evita apagar um
 * prazo sem querer quando outro campo do mesmo update não mexe nele. Aqui é
 * o oposto: sem apagar, a próxima varredura de `listarProntosParaRetomar`
 * acharia o mesmo lead de novo e reenviaria o follow-up para sempre.
 */
export async function limparRetomada(
  db: Db,
  tenantId: string,
  id: string,
): Promise<void> {
  await db.query(`update leads set resume_at = null where tenant_id = $1 and id = $2`, [
    tenantId,
    id,
  ]);
}

/**
 * Busca pelo endereço, normalizando como o índice único faz.
 *
 * `leads_tenant_email_uniq` é `(tenant_id, lower(email))`, então a busca usa
 * `lower(email)` para bater com ele — um webhook pode trazer o endereço com
 * outra caixa daquela que gravamos.
 */
export async function buscarLeadPorEmail(
  db: Db,
  tenantId: string,
  email: string,
): Promise<Lead | null> {
  const normalizado = email.trim().toLowerCase();
  if (normalizado.length === 0) return null;

  const { rows } = await db.query<Lead>(
    `select ${COLUNAS} from leads
     where tenant_id = $1 and lower(email) = $2`,
    [tenantId, normalizado],
  );
  return rows[0] ?? null;
}

/**
 * Marca que o endereço deu bounce.
 *
 * `coalesce` preserva a primeira data: o Instantly pode reentregar o evento, e
 * o que interessa é quando o endereço falhou pela primeira vez. A contagem do
 * disjuntor lê esta coluna — é ela que torna a proteção capaz de disparar.
 */
export async function marcarBounce(
  db: Db,
  tenantId: string,
  leadId: string,
): Promise<void> {
  await db.query(
    `update leads set bounced_at = coalesce(bounced_at, now())
     where tenant_id = $1 and id = $2`,
    [tenantId, leadId],
  );
}

export type ContagemPorEstagio = Record<LeadStage, number>;

/**
 * Conta os leads da campanha por estágio.
 *
 * Todos os estágios entram com zero antes do `group by`: o SQL não devolve
 * linha para estágio vazio, e o painel precisa mostrar "0 em conversa" — que
 * é informação — em vez de omitir a coluna, que o operador leria como erro
 * de carregamento. `::int` pelo mesmo motivo de `contarEmpresasPorStatus`.
 */
export async function contarLeadsPorEstagio(
  db: Db,
  tenantId: string,
  campaignId: string,
): Promise<ContagemPorEstagio> {
  const { rows } = await db.query<{ stage: LeadStage; total: number }>(
    `select stage, count(*)::int as total
     from leads
     where tenant_id = $1 and campaign_id = $2
     group by stage`,
    [tenantId, campaignId],
  );

  const contagem = {} as ContagemPorEstagio;
  for (const estagio of LEAD_STAGES) contagem[estagio] = 0;
  for (const linha of rows) {
    contagem[linha.stage] = linha.total;
  }
  return contagem;
}

export interface LeadDoPainel extends Lead {
  /** Nome da empresa, para a tela não precisar de uma segunda consulta por lead. */
  empresa: string;
}

/**
 * Lista os leads da campanha, do mais recente para o mais antigo.
 *
 * O join com `companies` repete o filtro de tenant nos dois lados. É de
 * propósito, pela mesma razão que `criarLead` exige o `where exists`: as duas
 * chaves estrangeiras são independentes, então um lead do tenant A apontando
 * para empresa do tenant B é aceito pelo esquema. Juntar só por `company_id`
 * exibiria o nome da empresa alheia na tela — que é exatamente o vazamento
 * que aquela guarda existe para impedir.
 */
export async function listarLeadsDaCampanha(
  db: Db,
  tenantId: string,
  campaignId: string,
  limite: number,
): Promise<LeadDoPainel[]> {
  const { rows } = await db.query<LeadDoPainel>(
    `select
            l.id, l.tenant_id, l.campaign_id, l.company_id, l.full_name,
            l.role_title, l.email, l.email_verified, l.stage, l.discard_reason,
            l.handoff_reason, l.exchange_count, l.resume_at, l.needs_human,
            l.bounced_at, l.created_at, l.updated_at,
            coalesce(c.trade_name, c.legal_name) as empresa
     from leads l
     join companies c
       on c.id = l.company_id and c.tenant_id = l.tenant_id
     where l.tenant_id = $1 and l.campaign_id = $2
     order by l.updated_at desc
     limit $3`,
    [tenantId, campaignId, limite],
  );
  return rows;
}
