/**
 * A table column header that sorts the table it belongs to.
 *
 * The clickable thing is a real <button> inside the <th>, not a click handler on
 * the cell: it is then reachable by Tab, activates on Enter and Space without
 * any key handling of our own, and is announced as a control rather than as
 * text that happens to respond to a mouse.
 *
 * `aria-sort` goes on the <th> — that is the element the attribute is defined
 * for — so a screen reader states the current order when it reads the column
 * instead of the arrow being the only signal.
 *
 * Shared rather than copied: the 201 File register and the Weekly Roster both
 * use it, and two hand-maintained copies would drift in exactly the details
 * (keyboard behaviour, aria-sort, arrow width) that are easy to leave out.
 *
 * Usage:
 *   const [sort, setSort] = useState({ key: "fullName", dir: "asc" });
 *   <SortableTh label="Full Name" sortKey="fullName" sort={sort} onSort={toggleSort} />
 */
export default function SortableTh({ label, sortKey, sort, onSort, style }) {
  const active = sort.key === sortKey;
  const dir = active ? sort.dir : null;
  return (
    <th
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      style={{ padding: 0, ...style }}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label} ${active && dir === "asc" ? "descending" : "ascending"}`}
        style={{
          all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
          width: "100%", boxSizing: "border-box", padding: "12px 14px",
          font: "inherit", color: "inherit", letterSpacing: "inherit", textTransform: "inherit",
        }}
      >
        {label}
        {/* The inactive glyph is dimmed rather than absent, so the column does
            not change width when it becomes the sorted one. */}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.35, fontSize: 10 }}>
          {active ? (dir === "asc" ? "▲" : "▼") : "▲"}
        </span>
      </button>
    </th>
  );
}

/**
 * The comparator both tables sort with.
 *
 * `numeric` so "2026-0002" sorts before "2026-0011" on the digits rather than
 * character by character — only accidentally right while every number is
 * zero-padded to the same width, and wrong the moment one is not.
 * `sensitivity: "base"` keeps "de la Cruz" beside "De La Cruz" instead of
 * grouping every capital first.
 */
export function compareBy(a, b, key, dir) {
  const av = String(a?.[key] ?? ""), bv = String(b?.[key] ?? "");
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
  return dir === "asc" ? cmp : -cmp;
}

/** First click sorts ascending; clicking the same column again reverses it. */
export function nextSort(current, key) {
  return current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" }
    : { key, dir: "asc" };
}
