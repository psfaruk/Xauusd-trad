/**
 * llm-types.ts — shared shapes for the AI stack (v23.0).
 * Kept in its own module so gate.ts / llm.ts / board.ts never cycle.
 */

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}
