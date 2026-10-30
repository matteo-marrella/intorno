/** Cornice rossa sottile, a LED, attorno a ciò che stai condividendo. Non cattura il mouse. */
export function ShareFrame(): React.JSX.Element {
  const r = Number(new URLSearchParams(location.hash.split('?')[1]).get('r') ?? 0)
  return <div className="led" style={{ borderRadius: r }} />
}
