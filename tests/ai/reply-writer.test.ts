import { describe, it, expect, vi } from "vitest";
import { writeReply, type ConversationTurn } from "../../src/ai/reply-writer.js";
import { depsComParse } from "../helpers/ai-mock.js";

const RASCUNHO = { subject: "Re: proposta", body: "Claro, segue o link..." };

const VOZ = {
  offerDescription: "Consultoria de dados e BI para indústrias.",
  tone: "consultivo, direto, sem jargão",
  senderFirstName: "Thiago",
};

const LINK = "https://cal.com/thiago/30min";

const HISTORICO: ConversationTurn[] = [
  { role: "us", body: "Olá Maria, vi que a Alfa..." },
  { role: "lead", body: "Interessante. Quanto custa?" },
];

function parseOk() {
  return vi
    .fn()
    .mockResolvedValue({ parsed_output: RASCUNHO, stop_reason: "end_turn" });
}

describe("writeReply", () => {
  it("devolve o rascunho retornado pelo modelo", async () => {
    const parse = parseOk();
    const resultado = await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    expect(resultado).toEqual(RASCUNHO);
  });

  it("inclui o link de agendamento na instrução quando a ação é enviá-lo", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain(LINK);
  });

  it("lista os pontos a endereçar quando a ação é responder e conduzir", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "answer_and_nudge", keyPoints: ["preço", "prazo"] },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("preço");
    expect(conteudo).toContain("prazo");
    expect(conteudo).toContain(LINK);
  });

  it("transcreve o histórico identificando quem falou", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("Nós: Olá Maria, vi que a Alfa...");
    expect(conteudo).toContain("Lead: Interessante. Quanto custa?");
  });

  it("mantém o tom da campanha no system cacheável", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "send_scheduling_link" },
      },
      depsComParse(parse),
    );
    const system = parse.mock.calls[0]![0].system[0];
    expect(system.text).toContain("consultivo, direto, sem jargão");
    expect(system.cache_control).toEqual({ type: "ephemeral" });
    // A assinatura vem da campanha, e não da imaginação do modelo — se cada
    // módulo inventasse um nome, a mesma thread seria assinada por duas pessoas.
    expect(system.text).toContain("Thiago");
  });

  it("escreve despedida cordial ao encerrar por recusa", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "close_lost", reason: "recusa do lead", suppress: false },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("agradeça");
    expect(conteudo).not.toContain(LINK);
  });

  it("propõe retomada futura sem link em 'não agora'", async () => {
    const parse = parseOk();
    await writeReply(
      {
        voice: VOZ,
        schedulingLink: LINK,
        history: HISTORICO,
        action: { type: "schedule_followup", resumeInDays: 90 },
      },
      depsComParse(parse),
    );
    const conteudo = parse.mock.calls[0]![0].messages[0].content as string;
    expect(conteudo).toContain("90");
    expect(conteudo).not.toContain(LINK);
  });

  it("recusa gerar e-mail para ação de repasse a humano", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "handoff_to_human", reason: "conversa longa sem desfecho" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("recusa gerar e-mail para descadastro", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: {
            type: "close_lost",
            reason: "pedido de descadastro",
            suppress: true,
          },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("recusa gerar e-mail para resposta fora do escopo", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "ignore", reason: "resposta fora do escopo" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/não gera e-mail/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("exige histórico não vazio", async () => {
    const parse = vi.fn();
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: [],
          action: { type: "send_scheduling_link" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/histórico/i);
    expect(parse).not.toHaveBeenCalled();
  });

  it("lança erro quando o modelo não devolve saída estruturada", async () => {
    const parse = vi
      .fn()
      .mockResolvedValue({ parsed_output: null, stop_reason: "refusal" });
    await expect(
      writeReply(
        {
          voice: VOZ,
          schedulingLink: LINK,
          history: HISTORICO,
          action: { type: "send_scheduling_link" },
        },
        depsComParse(parse),
      ),
    ).rejects.toThrow(/saída estruturada/);
  });
});
