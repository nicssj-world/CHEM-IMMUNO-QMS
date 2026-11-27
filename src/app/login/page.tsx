import type { Metadata } from 'next';
import { BarChart3, FlaskConical, PackageCheck, ShieldCheck } from 'lucide-react';
import { LoginForm } from '@/components/login-form';
import { safeReturnPath } from '@/lib/return-path';
import styles from './login.module.css';

export const metadata: Metadata = { title: 'เข้าสู่ระบบ' };

const benefits = [
  { icon: PackageCheck, label: 'Accurate Inventory Control' },
  { icon: ShieldCheck, label: 'Supports Laboratory Workflow' },
  { icon: BarChart3, label: 'Reliable Data for Better Care' },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const returnTo = safeReturnPath(next);

  return (
    <main className={styles.page}>
      <div className={styles.labScene} aria-hidden="true" />
      <div className={styles.orbit} aria-hidden="true" />
      <svg className={styles.molecule} width="248" height="270" viewBox="0 0 248 270" fill="none" aria-hidden="true">
        <g stroke="white" strokeWidth="2" opacity=".55">
          <path d="M42 105l48-29 48 29v56l-48 28-48-28v-56ZM138 105l48-29 48 29v56l-48 28-48-28v-56ZM90 76V22l31-18M90 189v49l-33 20" />
          <circle cx="42" cy="105" r="5" fill="white" /><circle cx="90" cy="76" r="5" fill="white" />
          <circle cx="138" cy="105" r="5" fill="white" /><circle cx="186" cy="76" r="5" fill="white" />
          <circle cx="234" cy="105" r="5" fill="white" /><circle cx="90" cy="189" r="5" fill="white" />
          <circle cx="138" cy="161" r="5" fill="white" /><circle cx="186" cy="189" r="5" fill="white" />
        </g>
      </svg>

      <div className={styles.stage}>
        <aside className={styles.intro} aria-label="เกี่ยวกับระบบ CHEM-IMMUNO CBH">
          <p className={styles.introEyebrow}>INVENTORY SYSTEM</p>
          <h1 className={styles.introTitle}>CHEM-IMMUNO CBH</h1>
          <span className={styles.accentLine} aria-hidden="true" />
          <p className={styles.tagline}>Laboratory inventory management<br />for better healthcare</p>
          <ul className={styles.benefits}>
            {benefits.map(({ icon: Icon, label }) => (
              <li className={styles.benefit} key={label}>
                <span className={styles.benefitIcon}><Icon size={24} strokeWidth={1.8} aria-hidden="true" /></span>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </aside>

        <section className={styles.card} aria-labelledby="login-heading">
          <header className={styles.cardBrand}>
            <span className={styles.flaskBadge}><FlaskConical size={44} strokeWidth={1.8} aria-hidden="true" /></span>
            <p className={styles.cardEyebrow}>INVENTORY SYSTEM</p>
            <p className={styles.cardTitle}>CHEM-IMMUNO CBH</p>
            <span className={styles.cardDivider} aria-hidden="true" />
          </header>
          <div className={styles.formHeading}>
            <h2 id="login-heading">เข้าสู่ระบบ</h2>
            <p>ใช้เลข Ephis ID ในการเข้าสู่ระบบ</p>
          </div>
          {error && <p className={`error ${styles.feedback}`} role="alert">{error === 'configuration' ? 'ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบ' : 'Ephis ID หรือรหัสผ่านไม่ถูกต้อง หรือยังไม่มีสิทธิ์ใช้งาน'}</p>}
          {returnTo && !error && <p className={`notice ${styles.feedback}`} role="status">เซสชันหมดอายุ · เข้าสู่ระบบอีกครั้งเพื่อกลับไปยังหน้าที่ทำค้างไว้</p>}
          <LoginForm next={returnTo ?? ''} />
        </section>
      </div>
    </main>
  );
}
