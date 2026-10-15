# Overvågning

Tjekker hvert 5. minut, at portal.etkreativt.dk svarer, og sender en SMS til et kreativt bureau, når portalen er nede, og når den svarer igen.

- Logik og tests: `scripts/overvaagning.mjs` og `scripts/overvaagning.test.mjs` (`node --test scripts/overvaagning.test.mjs`).
- Kørsel: `.github/workflows/overvaagning.yml`.
- Hold i live: `.github/workflows/hold-i-live.yml` laver en tom commit hver måned, så GitHub ikke pauser kørslerne.
- Nøgler og telefonnummer ligger som GitHub-secrets og står aldrig her.
