# Race & Class Builder

A shared, no-login website for building custom Races and Classes with the point-buy system
from the Dungeon Crawler Carl RPG. Anyone who opens the site sees every build, can make new
ones, and can edit or delete any of them. A finished build has a **Click to copy** button
that copies it as Discord-ready text.

It's one static page plus one Netlify Function. Builds are stored in Netlify Blobs, so there's
no database to set up. Changes show up for everyone within about 20 seconds.

```
public/index.html                the page
public/app.js                    the builder
public/rules.js                  Build Point rules and every benefit/detriment option from the book
public/styles.css                the look
netlify/functions/builds.mjs     the API (/api/builds), stores the builds
netlify.toml                     tells Netlify where things are
```

## Put it on Netlify (one time)

You need a free [GitHub](https://github.com) account and a free [Netlify](https://netlify.com) account.

1. **Put this folder in a new GitHub repo.** Either push it with git:
   ```
   git init -b main
   git add .
   git commit -m "Race & Class Builder"
   git remote add origin https://github.com/YOUR-NAME/dcc-race-class-builder.git
   git push -u origin main
   ```
   or create an empty repo on github.com and use **uploading an existing file** to drag the
   contents in. Keep the folder structure, and skip `node_modules` if you have one.
2. **Connect it to Netlify.** In Netlify: **Add new site → Import an existing project → GitHub**,
   then pick the repo. Every setting comes from `netlify.toml`, so leave the build command and
   publish directory as Netlify fills them in. Click **Deploy**.
3. **Give it a name.** **Site configuration → Change site name** turns the random address into
   something like `grubkin-builds.netlify.app`.

That's it. There's no password or environment variable to set; Netlify Blobs is switched on
for every site automatically. Send people the link.

From then on, every push to GitHub redeploys the site. Deploys never touch the saved builds.

### Without GitHub

If you'd rather skip GitHub, deploy from your computer with the Netlify CLI (needs
[Node.js](https://nodejs.org) 18 or newer):

```
npm install
npx netlify-cli login
npx netlify-cli deploy --prod
```

The first run asks you to create or link a site. Run the last command again whenever you
change something. (Netlify's drag-and-drop "Deploy manually" box won't work: it can't run the
API function.)

## Using it

- **New race / New class** starts a build. Races get 25 Build Points, Classes 30, plus up to 5
  more from detriments. Pick benefits and detriments from the book's tiers, or write your own
  at a tier's price.
- A build is **finished** when it has a name and every Build Point is spent. Finished builds open
  on a read-only page; drafts open in the editor. Drafts can be saved too.
- **Click to copy** copies a finished build as Discord markdown: a heading, the benefits and
  detriments with their tier and cost, the Build Point math, and a link back to the build.
  Discord allows 2,000 characters per message (4,000 with Nitro); the page warns when a build is
  longer.
- **Copy link** copies the build's address (`…/#b/<id>`) so people can open it directly.
- **Duplicate** starts a new build from an existing one. Handy for riffing on someone else's
  build without changing theirs.
- If two people edit the same build at once, whoever saves second is asked whether to overwrite
  or load the other version.

## Backups

Everything is editable by everyone, so keep a copy:

- **Download all** (top right) saves every build to a JSON file.
- **Import** adds the builds from such a file. Builds already on the site with the same id are
  replaced by the file's version; nothing else is deleted. It also reads a **Crawler Roster**
  "Back up everything" file, so builds from a campaign site can be brought over (their GM
  approval is dropped, since this site has none).

## Limits

The API has no password, so anyone on the internet can call it. To keep a bot from filling the
storage:

- each field is cut to a sane length (names 120 characters, flavor 2,000, each benefit 600,
  40 benefits and 40 detriments per build), and
- the site holds at most **1,000 builds** (and 8 MB in total). Past that, saving a new build
  asks people to delete old ones first.

To change the build limit, add an environment variable `MAX_BUILDS` in Netlify
(**Site configuration → Environment variables**) and redeploy.

If someone vandalizes the builds, restore them from a **Download all** file with **Import**.

## Changing the rules

The benefit and detriment lists, their costs and the Build Point totals are all in
`public/rules.js`. Fix a typo or add an option there and push; every build picks it up. (Builds
store the text they were made with, so editing an option doesn't change builds that already
use it.)

## Running it on your computer

```
npm install
npx netlify-cli dev
```

`netlify dev` serves the page and the function together at http://localhost:8888 and keeps
builds in a local Blobs sandbox, separate from the live site.
