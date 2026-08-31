import { describe, it, expect } from "vitest";
import { LEAD_STAGES, REPLY_INTENTS } from "../../src/db/types.js";

describe("constantes de domínio", () => {
  it("expõe exatamente os sete estágios do funil", () => {
    expect(LEAD_STAGES).toEqual([
      "discovered",
      "enriched",
      "contacted",
      "in_conversation",
      "meeting_booked",
      "discarded",
      "error",
    ]);
  });

  it("expõe exatamente as seis intenções de resposta", () => {
    expect(REPLY_INTENTS).toEqual([
      "interested",
      "question_or_objection",
      "not_now",
      "no",
      "opt_out",
      "out_of_scope",
    ]);
  });
});
