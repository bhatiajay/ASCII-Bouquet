# ASCII Bouquet

A procedural ASCII art animation of a blooming lily bouquet under a starry sky, inspired by botanical simulations.

- Branching Bézier stems with spiraling leaves, plus baby's breath and eucalyptus filler
- Lilies with six pointed petals, painted veins and freckles, long stamens with rust-colored anthers, and a pistil
- A growth timeline for each lily: the stem grows, a slender closed bud swells, the petals unfurl into a star, and the stamens appear
- A twinkling night sky, and rippling water at the bottom that reflects the open blossoms
- A gentle breeze that sways the taller stems more
- A vector-to-ASCII pipeline: shapes are painted onto a low-res offscreen canvas, each pixel's brightness picks a character from ` .:-=+*cxoaX#%&@`, and the glyphs are colored over a soft glow
- A pastel palette: baby blue and baby pink petals with blushing tips and dark centers
- A crescent moon in the corner, reflected in the water
- Generated music (no audio files): a soft chord pad and a wandering music-box melody, with a chime as each lily opens
- Night-time ambience: crickets, lapping water, a breeze that rises and falls with the swaying stems, and the occasional owl
- An orange tabby cat built from cubic and quadratic Bézier curves (arched back, belly, legs, ears and a tapering tail). Its control points move with what it's doing:
  - On its own it sits, wanders, grooms, stretches, naps, rolls onto its back, and rears up to bat at the stems, which wobble and bob their lilies
  - Grab it by the scruff of its neck and it dangles: its body stretches, its legs hang, its paws wriggle, and it swings as you drag it
  - Drop or throw it and it rights itself as it falls, splashes into the water, bobs back up and shakes itself off
  - It meows when you grab it, and the splash makes a sound too. Both are synthesized like the music
- The bouquet stays in full bloom until you replant it

## Run it

Open `index.html` in a web browser.

- **Drag the cat by the scruff** (the back of its neck; the cursor changes to a hand) to pick it up. Let go to drop it, or fling it.
- **Click the cat's body** to startle it.
- **Click anywhere else, or press any key,** to replant the bouquet.
- **M** toggles sound. The first click or key press starts the music.

In the browser console, `BouquetCat.setBehavior('roll')` makes the cat do something right away (`sit`, `walk`, `groom`, `roll`, `paw`, `stretch` or `nap`).
