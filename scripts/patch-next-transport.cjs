// Next 16.4.2 leaves transport-only promises pending after a client disconnect.
// Settle those waits, not the surrounding application/credential work. Pin and
// verify the dependency shape so a framework update cannot silently lose this fix.
const fs = require("node:fs");
const path = require("node:path");

const root = path.dirname(require.resolve("next/package.json"));
if (require(path.join(root, "package.json")).version !== "16.4.2") {
  throw new Error("Review the disconnect patch before changing Next 16.4.2");
}

function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) throw new Error(`Next transport patch drift: ${file}`);
  return source.replace(before, after);
}

for (const directory of ["dist/server", "dist/esm/server"]) {
  const staticFile = path.join(root, directory, "serve-static.js");
  let source = fs.readFileSync(staticFile, "utf8");
  if (!source.includes("// AIProxy: settle static transport on disconnect.")) {
    source = replaceOnce(source, "    return new Promise((resolve, reject)=>{\n", `    return new Promise((resolve, reject)=>{
        // AIProxy: settle static transport on disconnect.
        const cleanup = ()=>{
            res.off('finish', finish);
            res.off('close', finish);
        };
        const finish = ()=>{ cleanup(); resolve(); };
        const fail = (error)=>{ cleanup(); reject(error); };
        res.once('finish', finish);
        res.once('close', finish);
        if (res.destroyed || res.writableFinished) return finish();
`, staticFile);
    source = replaceOnce(source, "            reject(err);", "            fail(err);", staticFile);
    source = replaceOnce(source, ").on('error', reject).pipe(res).on('finish', resolve);", ").on('error', fail).pipe(res);", staticFile);
    fs.writeFileSync(staticFile, source);
  }

  const streamFile = path.join(root, directory, "pipe-readable.js");
  source = fs.readFileSync(streamFile, "utf8");
  if (!source.includes("// AIProxy: settle output completion on disconnect.")) {
    source = replaceOnce(source, `    res.once('finish', ()=>{
        finished.resolve();
    });`, `    // AIProxy: settle output completion on disconnect.
    const finishOutput = ()=>{
        res.off('finish', finishOutput);
        res.off('close', finishOutput);
        finished.resolve();
    };
    res.once('finish', finishOutput);
    res.once('close', finishOutput);
    if (res.destroyed || res.writableFinished) finishOutput();`, streamFile);
    fs.writeFileSync(streamFile, source);
  }
}
