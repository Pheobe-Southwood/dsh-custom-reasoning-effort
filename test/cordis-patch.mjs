/**
 * The one reader of `cordis.patch.yml` this package's tests share.
 *
 * The patch is parsed by a shape-specific reader rather than a YAML dependency:
 * this package deliberately has exactly one runtime dependency (the harness's
 * own schema library), and the file's shape is one `insert:` list of scalar
 * `id`/`name` rows (see the file's own comments). Comments are stripped before
 * matching, because the file documents every row at length.
 */

/**
 * Every inserted row, in file order.
 * @param {string} text - the patch document.
 * @returns {{ id: string, name: string | undefined }[]} the rows it inserts.
 */
export function patchRows(text) {
  const rows = []
  let current
  for (const line of text.split('\n').map((line) => line.replace(/#.*$/, ''))) {
    const id = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      current = { id: id[1], name: undefined }
      rows.push(current)
      continue
    }
    const name = /^\s+name:\s*(\S+)\s*$/.exec(line)
    if (name !== null && current !== undefined) {
      current.name = name[1]
      current = undefined
    }
  }
  return rows
}
