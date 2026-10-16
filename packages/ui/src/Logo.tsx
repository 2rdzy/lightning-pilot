// The mark (vault design/logo, "network dial"): a red coin with a white ₿ tilted 14°, a ring of five nodes and a
// lightning bolt in the ring's opening. `small` is the favicon variant (no nodes, stronger ring) for 16–24 px.
// The same artwork as apps/web/public/favicon.svg; drawn with React elements, so no inline markup reaches the CSP.
const RING = 'M17.09 69.00A38 38 0 1 1 82.91 69.00';
const NODES = [
  [17.09, 69],
  [17.09, 31],
  [50, 12],
  [82.91, 31],
  [82.91, 69],
] as const;
const COIN_B =
  'M34 24H57C67 24 72 30 72 37C72 42 69 46 65 48C71 50 75 55 75 61.5C75 70.5 68 76 58 76H34ZM43 32V45H55.5C60 45 62.5 42.5 62.5 38.5C62.5 34.5 60 32 55.5 32ZM43 53V68H57C62.5 68 65.5 65 65.5 60.5C65.5 56 62.5 53 57 53Z M40 15h5v9h-5z M49 15h5v9h-5z M40 76h5v9h-5z M49 76h5v9h-5z';
const BOLT = 'M58 6L28 54H48L40 94L74 42H54Z';

export function Logo({ size = 32, label, small = false }: { size?: number; label?: string; small?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-testid="logo"
    >
      <circle cx="50" cy="50" r="48" fill="#C4402A" />
      <path d={RING} fill="none" stroke="#fff" strokeWidth={small ? 4 : 2} strokeLinecap="round" />
      {small
        ? null
        : NODES.map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="6" fill="#fff" stroke="#C4402A" strokeWidth="2" />
          ))}
      <path
        fill="#fff"
        fillRule="evenodd"
        transform="rotate(14 50 50) translate(50 48) scale(.52) translate(-54 -50)"
        d={COIN_B}
      />
      <path fill="#fff" transform="translate(50 81) scale(.3) translate(-51 -50)" d={BOLT} />
    </svg>
  );
}
