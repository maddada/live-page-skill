# Ghostex page kit

`ghostex-kit.html` is the theme, page API, question kit and fit script that Ghostex inlines into an
exported Live page (`ghostex visual export`), so this skill's pages look and work like Ghostex's
Live pages in any browser. It comes from [Ghostex](https://github.com/maddada/Ghostex) under the MIT
License:

> Copyright 2026 Mohamad Yahia (maddada)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
> associated documentation files (the "Software"), to deal in the Software without restriction,
> including without limitation the rights to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
> NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
> OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

live-page.mjs adds it to each page's `<head>` when it serves the page, with the page's state
where the `<!--live-page:state-->` marker sits. Maintainers refresh it with
`node scripts/extract-kit.mjs <exported.html>` (see that script).
