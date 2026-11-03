# ASCII Bouquet

A procedural ASCII art animation of a blooming flower bouquet, inspired by botanical simulations.

- Branching Bézier stems with spiraling leaves, plus baby's breath and eucalyptus filler
- A growth timeline for each flower: the stem grows, the bud swells, the petals open, and the stamens appear
- A gentle breeze that sways the taller stems more
- A vector-to-ASCII pipeline: shapes are painted onto a low-res offscreen canvas, each pixel's brightness picks a character from ` .:-=+*cxoaX#%&@`, and the glyphs are colored over a soft glow
- A pastel palette: baby blue and baby pink petals with blushing tips and dark centers

## Run it

Open `index.html` in a web browser. Click, or press any key, to replant the bouquet.
