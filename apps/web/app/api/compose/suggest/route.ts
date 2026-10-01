import { z } from "zod";
import { getDb, getProviderSecret, getProviderSettings, listTemplates } from "@vs/db";
import { composerQuestions, interpretComposer, JevClient, JevError, JevSettings, type SuggestTemplate } from "@vs/providers";
import { TemplateDefinition } from "@vs/templates";
import { requireSession } from "@/lib/server/auth";
import { body, json, route } from "@/lib/server/http";

export const dynamic = "force-dynamic";

/**
 * Live suggestions for the composer from Jev (when a Jev key is set up): template, orientation,
 * length, writing style and voiceover, picked from what the owner has typed so far. Never
 * blocks the composer: no key, a slow answer or an error just means no suggestions.
 */
export const POST = route(async (req) => {
  const s = await requireSession();
  const b = await body(req, z.object({ prompt: z.string().trim().min(12).max(1500), templateId: z.string().max(64).nullable().optional(), candidates: z.array(z.string().max(64)).max(60).default([]), attachments: z.object({ image: z.number().int().min(0).max(50), video: z.number().int().min(0).max(50), audio: z.number().int().min(0).max(50) }).partial().default({}) }));
  const key = await getProviderSecret(getDb(), s.workspaceId, "jev");
  if (!key) return json({ available: false });
  const rows = await listTemplates(getDb(), s.workspaceId);
  const all: SuggestTemplate[] = rows.map(({ template, version }) => {
    const d = TemplateDefinition.parse(version.definition);
    return { id: template.id, name: d.name, description: d.description, supportedAspects: d.supportedAspects, duration: d.duration, needsFootage: d.inputs.some((i) => i.required && i.kind === "video") };
  });
  // Only templates the composer can use right now (it sends the ready ones). Templates built from
  // the owner's own recording stay in: a lesson described before its recording is attached should
  // still be suggested, marked as needing that recording.
  const usable = b.candidates.length ? all.filter((t) => b.candidates.includes(t.id)) : all;
  const footageAttached = (b.attachments.video ?? 0) > 0;
  const chosen = b.templateId ? (all.find((t) => t.id === b.templateId) ?? null) : null;
  const state = { request: b.prompt, attached: { images: b.attachments.image ?? 0, footage: b.attachments.video ?? 0, music: b.attachments.audio ?? 0 }, ...(chosen ? { chosenTemplate: chosen.name } : {}) };
  try {
    const r = await new JevClient(key.secret, JevSettings.parse(await getProviderSettings(getDb(), s.workspaceId, "jev"))).decide(state, composerQuestions(usable, chosen), { timeoutMs: 3000, signal: req.signal });
    return json({ available: true, suggestion: interpretComposer(r.answers, usable, chosen, { footageAttached }), elapsedMs: r.elapsedMs });
  } catch (e) {
    return json({ available: true, suggestion: {}, error: e instanceof JevError ? e.message : "Jev suggestions are unavailable right now." });
  }
});
