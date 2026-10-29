// Round avatar: the uploaded picture, or initials on a colour picked from
// the user id so everyone keeps the same colour everywhere.

const COLORS = ['#5b8def', '#e5484d', '#3ecf8e', '#f5a524', '#a970ff', '#ff6fb5', '#1fb6c9', '#d97757'];

export default function Avatar({ user, size = 36, className = '' }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (user?.avatar_url) {
    return <img className={`avatar ${className}`} style={style} src={user.avatar_url} alt="" loading="lazy" draggable={false} />;
  }
  const name = user?.display_name || user?.username || '?';
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return (
    <span className={`avatar initials ${className}`} style={{ ...style, background: COLORS[(user?.id || 0) % COLORS.length] }} aria-hidden="true">
      {initials}
    </span>
  );
}
