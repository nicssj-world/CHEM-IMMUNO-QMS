// A plain div, not a main landmark: the page that replaces it renders its own main. Shown inside the app shell while a page's server data loads, so a tap on slow lab Wi-Fi gives immediate feedback.
export default function Loading() {
  return <div className="grid gap-6" aria-busy="true">
    <p className="sr-only" role="status">กำลังโหลดข้อมูล…</p>
    <div className="grid gap-3" aria-hidden><div className="skeleton h-3 w-32" /><div className="skeleton h-9 w-72 max-w-full" /><div className="skeleton h-3 w-56 max-w-full" /></div>
    <div className="skeleton h-14 w-full max-w-[560px]" aria-hidden />
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3" aria-hidden>{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-24" />)}</div>
    <div className="skeleton h-56 w-full" aria-hidden />
  </div>;
}
