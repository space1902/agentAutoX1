/** Hours a pod may stay off before the auto review turns it on (mirrors settings.rs KEEP_ALIVE_HOURS). */
export const KEEP_ALIVE_HOURS = [4, 6, 8, 12, 24, 36, 48, 72] as const;
export const DEFAULT_KEEP_ALIVE_HOURS = 6;

export const intervalLabel = (hours: number) => `${hours} h`;

export const keepAliveHelp = (hours: number) =>
  `Evita que WhatsApp desvincule los dispositivos de los pods apagados: enciende, uno por uno, cada pod que lleve más de ${hours} horas apagado durante 15 minutos y luego lo apaga. Recomendado: 24 h o menos; con intervalos más largos se acumulan más mensajes pendientes en los chats.`;
