import { motion, type HTMLMotionProps } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export type PillTone = "green" | "gray" | "amber" | "red";

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

/** Card that lifts on hover. */
export function Card({ className = "", children, ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div
      className={`card lift ${className}`}
      whileHover={{ y: -4 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function Banner({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <header className="banner">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children && <div className="banner-actions">{children}</div>}
    </header>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  caption,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  caption: string;
}) {
  return (
    <Card className="stat">
      <div className="stat-icon">
        <Icon size={17} aria-hidden />
      </div>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-caption">{caption}</span>
    </Card>
  );
}

export function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height }} aria-hidden />;
}

export function SkeletonGrid({ count = 3, height = 170 }: { count?: number; height?: number }) {
  return (
    <div className="grid" role="status" aria-label="Cargando">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} />
      ))}
    </div>
  );
}

export function Notice({ kind = "error", children }: { kind?: "error" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice ${kind === "ok" ? "ok" : ""}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
