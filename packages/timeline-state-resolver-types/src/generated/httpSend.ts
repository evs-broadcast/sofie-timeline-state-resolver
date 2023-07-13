/* eslint-disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run "yarn generate-schema-types" to regenerate this file.
 */

export interface HTTPSendOptions {
	/**
	 * Minimum time in ms before a command is resent, set to <= 0 or undefined to disable
	 */
	resendTime?: number
}

export type SomeMappingHttpSend = Record<string, never>

export type SendCommandPayload = HTTPSendCommandContent

export enum HttpSendActions {
	Resync = 'resync',
	SendCommand = 'sendCommand',
}
