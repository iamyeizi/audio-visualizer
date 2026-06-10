import * as ToastPrimitive from "@radix-ui/react-toast";
import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastVariant = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastViewportProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

const icons = {
  success: CheckCircle2,
  error: TriangleAlert,
  info: Info,
};

export function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  return (
    <ToastPrimitive.Provider duration={Number.POSITIVE_INFINITY} swipeDirection="right">
      {toasts.map((toast) => {
        const Icon = icons[toast.variant];
        return (
          <ToastPrimitive.Root
            key={toast.id}
            open
            duration={Number.POSITIVE_INFINITY}
            onOpenChange={(open) => { if (!open) onDismiss(toast.id); }}
            className={cn(
              "glass relative grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 rounded-xl border p-4 pr-3 shadow-2xl",
              "data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:animate-toast-swipe-out",
              toast.variant === "error" && "border-red-500/35 bg-red-950/80",
              toast.variant === "success" && "border-emerald-500/30 bg-emerald-950/75",
              toast.variant === "info" && "border-primary/30 bg-card/95",
            )}
          >
            <Icon className={cn("mt-0.5 h-4 w-4", toast.variant === "error" && "text-red-300", toast.variant === "success" && "text-emerald-300", toast.variant === "info" && "text-primary")} />
            <div className="min-w-0">
              <ToastPrimitive.Title className="text-sm font-medium text-foreground">{toast.title}</ToastPrimitive.Title>
              {toast.description && <ToastPrimitive.Description className="mt-1 text-xs leading-5 text-muted-foreground">{toast.description}</ToastPrimitive.Description>}
            </div>
            <ToastPrimitive.Close aria-label="Cerrar notificación" className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
              <X className="h-4 w-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed right-0 top-0 z-[100] flex max-h-screen w-full flex-col gap-3 p-4 sm:w-[420px] sm:p-6" />
    </ToastPrimitive.Provider>
  );
}
