// =============================
// src/components/protocol/ToastNotification.tsx
// =============================
import React from "react";
import { motion } from "framer-motion";
import { CheckCircle, AlertTriangle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info" | "warning";

export interface ToastData {
  id?: string | number;
  type: ToastKind;
  message: string;
}

interface ToastProps {
  toast: ToastData;
  onClose?: (id?: string | number) => void;
}

export function ToastNotification({ toast, onClose }: ToastProps) {
  const icons: Record<ToastKind, React.ElementType> = {
    success: CheckCircle,
    error: AlertTriangle,
    info: Info,
    warning: AlertTriangle,
  };

  const colors: Record<ToastKind, string> = {
    success: "from-emerald-500/20 to-teal-500/20 border-emerald-500/30",
    error: "from-red-500/20 to-rose-500/20 border-red-500/30",
    info: "from-blue-500/20 to-indigo-500/20 border-blue-500/30",
    warning: "from-amber-500/20 to-yellow-500/20 border-amber-500/30",
  };

  const iconColors: Record<ToastKind, string> = {
    success: "text-emerald-400",
    error: "text-red-400",
    info: "text-blue-400",
    warning: "text-amber-400",
  };

  const Icon = icons[toast.type];

  return (
    <motion.div
      role="alert"
      aria-live="polite"
      initial={{ opacity: 0, x: 100, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 100, scale: 0.9 }}
      className={`bg-gradient-to-r ${colors[toast.type]} backdrop-blur-xl border rounded-xl p-4 max-w-sm shadow-lg`}
    >
      <div className="flex items-start space-x-3">
        <Icon className={`w-5 h-5 mt-0.5 ${iconColors[toast.type]}`} />
        <span className="text-white font-medium flex-1">{toast.message}</span>
        {onClose && (
          <button
            aria-label="Close"
            onClick={() => onClose(toast.id)}
            className="text-slate-400 hover:text-white"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </motion.div>
  );
}

export default ToastNotification;
