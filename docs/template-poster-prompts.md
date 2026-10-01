# Template thumbnails — GPT Image 2 prompts

Each template card shows `apps/web/public/template-posters/<template-id>.png` (or `.jpg` /
`.webp`) when that file exists; otherwise a real frame rendered by its template family
(`template-posters/frames/`, kept separate so presets never borrow another template's art),
otherwise a gradient. Generate one image per template below, save it under the exact file name, and reload
the page — no code change or restart needed.

**Settings:** landscape 1536×1024 (the card crops to 16:9, so keep the subject centred with
margin top and bottom), high quality, PNG.

**Keep them honest.** Each prompt describes what that template actually produces (motion
graphics, flat vector characters, procedural visuals), so the thumbnail doesn't promise a look the
template can't deliver. Avoid real brands, logos and real people.

## Shared style (paste at the start of every prompt)

> Thumbnail for a video template in a dark, premium creative app. Cinematic 16:9 composition,
> deep indigo-to-near-black background with a soft violet glow, one clear focal subject centred
> with generous margins, subtle film grain and vignette, crisp modern motion-graphics look,
> limited palette of indigo, violet and warm amber accents. No watermark, no UI chrome, no real
> brand names or logos.

## Prompts

| File | Template | Prompt (after the shared style) |
| --- | --- | --- |
| `product-launch.png` | Product Launch | A sleek laptop at a slight angle showing a clean, dark productivity dashboard with soft cards and a small bar chart; a bold headline area to the left in abstract light bars (no readable text); a soft spotlight and floating UI cards drifting out of the screen, like a frame from a polished SaaS launch video. |
| `motion-reel.png` | Motion Graphics Reel | Pure kinetic typography and shapes: a large amber circle pulsing behind one bold sans-serif word “FOCUS”, thin rings expanding outward, a row of amber bars rising like an equaliser at the bottom; flat vector shapes, strong contrast, a sense of motion blur on the edges. |
| `vertical-short.png` | Vertical Short with Voiceover | A smartphone standing upright in the centre showing a vertical video frame: a big bold two-line headline in white on indigo with one boxed caption line near the bottom, a small progress bar at the top; soft light around the phone, social-video energy. |
| `brand-showreel.png` | Brand / Channel Showreel | A wall of small rounded video thumbnails in a grid, softly tinted indigo, converging toward one bright amber circle motif in the centre that glows like a hero moment; clean editorial layout, one colour motif tying everything together. |
| `talking-head.png` | Talking-Head Enhancement | A friendly flat-vector presenter (simple geometric illustration, not a real person) framed from the chest up in a calm home studio with a plant and a framed picture; a clean lower-third caption bar and a small floating title card beside them; warm, approachable, editorial illustration style. |
| `presenter-intro.png` | Presenter Motion Intro | The same style of flat-vector presenter, smaller and to the right, with bold motion-graphics labels and a logo-shaped abstract mark sliding in on the left, punchy amber accent lines and a crisp name-title card; energetic intro feel. |
| `whiteboard-explainer.png` | Whiteboard Explainer | A clean off-white whiteboard canvas with hand-drawn style marker diagrams — arrows, a simple flowchart with three boxes and a lightbulb doodle — and a small flat-vector presenter in a rounded inset at the corner; bright, educational, minimal colour with indigo and amber marker strokes. |
| `course-lesson.png` | Course Lesson | A calm lesson layout: a rounded presenter inset on the left (flat-vector illustration) and three large, simple takeaway cards stacked on the right with check icons and abstract text lines (no readable text); soft, quiet, trustworthy learning atmosphere. |
| `music-video.png` | Animated Music Video | Procedural music visuals: a glowing amber ring that pulses over an indigo-violet gradient sky, a row of audio bars along the bottom reacting to sound, faint lyric-like light streaks; dreamy night-drive mood, rhythmic and hypnotic. |
| `mascot-story.png` | Mascot Story | A cute flat-vector robot mascot (rounded green body, big friendly eyes, small antenna) waving in the centre with a soft glow behind it, a simple shadow underneath, and faint hints of different eras around it (a garage door, a city skyline, the moon); playful storybook feel. |
| `anime-opening.png` | Anime Opening | Cel-shaded anime opening frame: a lone character silhouette in a long coat standing on a rooftop against a huge sunset over a floating city skyline, speed lines and light streaks, dramatic low angle; vivid magenta-to-amber sky, cinematic title-sequence energy. |
| `product-spec-ad.png` | Physical Product Spec Ad | A premium physical product (a matte coral water bottle) on a soft studio pedestal with rim lighting, two thin callout lines pointing to features with small abstract label pills (no readable text), clean reflective floor; high-end product commercial look. |
| `event-sizzle.png` | Event Sizzle Reel | An energetic conference moment: a stage with a speaker silhouette backlit by bright spotlights, an audience in the foreground as soft bokeh silhouettes, a quote-card overlay shape and amber light flares; real-event documentary feel, warm and lively. |

## Tips

- Generate all 13 in one session and keep the shared style identical, so the gallery reads as
  one set.
- If a result has stray text or a fake logo, regenerate with “no text” added at the end.
- Square or vertical outputs will be cropped; ask for landscape.
- To go back to the rendered frame for a template, delete its file.
