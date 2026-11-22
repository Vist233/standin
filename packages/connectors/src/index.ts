export { type ChatBridgeOptions, createChatBridge } from "./chat/bridge.ts";
export { type MatrixOptions, openMatrix } from "./chat/matrix.ts";
export { openSatori, type SatoriOptions, type SatoriSocket, satoriText } from "./chat/satori.ts";
export type { ChatEvent, ChatSource } from "./chat/types.ts";
export { createWatchSources, cursorIn, type EventSource, type WatchOptions } from "./event-source.ts";
export { addressOf, createMailChannel, type MailChannelOptions, replyText } from "./mail-channel.ts";
export { createTempMailAddresses, createTempMailProvider, type ReadState, type TempMailAccount, type TempMailSite } from "./providers/temp-mail.ts";
export { openTempMailAccount, TEMP_MAIL_VARIABLES, type TempMailAccountOptions, tempMailSettings } from "./providers/temp-mail-account.ts";
export { type GraphAccount, openGraphMailbox } from "./providers/graph.ts";
export { createTokenKeeper, type DeviceLogin, type MicrosoftApp, startDeviceLogin, type TokenKeeper, type TokenSet } from "./providers/microsoft-login.ts";
export { ProviderRegistry, type ProviderFactory } from "./registry.ts";
export { createTelegramChannel, type TelegramChannelOptions } from "./telegram-channel.ts";
export { createConnectorTools, untrusted } from "./tools.ts";
export type {
  Account,
  CalendarEvent,
  CalendarProvider,
  MailDraft,
  MailMessage,
  MailQuery,
  MailReader,
  MailSender,
  MailSummary,
  MailWatchOptions,
  NewCalendarEvent,
  Provider,
  Provisioner,
  Stop,
} from "./types.ts";
