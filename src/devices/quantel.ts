import * as _ from 'underscore'
import {
	DeviceWithState,
	CommandWithContext,
	DeviceStatus,
	StatusCode
} from './device'

import {
	DeviceType,
	DeviceOptions,
	Mapping,
	MappingQuantel,
	QuantelOptions,
	TimelineObjQuantelClip,
	QuantelControlMode
} from '../types/src'

import {
	TimelineState, ResolvedTimelineObjectInstance
} from 'superfly-timeline'

import { DoOnTime, SendMode } from '../doOnTime'
import {
	QuantelGateway
} from './quantelGateway'

const IDEAL_PREPARE_TIME = 1000
const PREPARE_TIME_WAIT = 50
const SOFT_JUMP_WAIT_TIME = 100

const DEFAULT_FPS = 50 // frames per second
const JUMP_ERROR_MARGIN = 5 // frames

export interface QuantelDeviceOptions extends DeviceOptions {
	options?: {
		commandReceiver?: CommandReceiver

	}
}
export type CommandReceiver = (time: number, cmd: QuantelCommand, context: string, timelineObjId: string) => Promise<any>
/**
 * This class is used to interface with a Quantel-gateway,
 * https://github.com/nrkno/tv-automation-quantel-gateway
 *
 * This device behaves a little bit different than the others, because a play-command is
 * a two-step rocket.
 * This is why the commands generated by the state-diff is not one-to-one related to the
 * actual commands sent to the Quantel-gateway.
 */
export class QuantelDevice extends DeviceWithState<QuantelState> {

	private _quantel: QuantelGateway
	private _quantelManager: QuantelManager

	private _commandReceiver: CommandReceiver

	private _doOnTime: DoOnTime
	private _connectionOptions?: QuantelOptions

	constructor (deviceId: string, deviceOptions: QuantelDeviceOptions, options) {
		super(deviceId, deviceOptions, options)

		if (deviceOptions.options) {
			if (deviceOptions.options.commandReceiver) this._commandReceiver = deviceOptions.options.commandReceiver
			else this._commandReceiver = this._defaultCommandReceiver
		}
		this._quantel = new QuantelGateway()
		this._quantel.on('error', e => this.emit('error', 'Quantel.QuantelGateway', e))

		this._quantelManager = new QuantelManager(
			this._quantel,
			() => this.getCurrentTime()
		)

		this._doOnTime = new DoOnTime(() => {
			return this.getCurrentTime()
		}, SendMode.IN_ORDER, this._deviceOptions)
		this._doOnTime.on('error', e => this.emit('error', 'Quantel.doOnTime', e))
		this._doOnTime.on('slowCommand', msg => this.emit('slowCommand', this.deviceName + ': ' + msg))
	}

	async init (connectionOptions: QuantelOptions): Promise<boolean> {
		this._connectionOptions = connectionOptions
		if (!this._connectionOptions.gatewayUrl) 	throw new Error('Quantel bad connection option: gatewayUrl')
		if (!this._connectionOptions.ISAUrl)		throw new Error('Quantel bad connection option: ISAUrl')
		if (!this._connectionOptions.serverId)		throw new Error('Quantel bad connection option: serverId')

		await this._quantel.init(
			this._connectionOptions.gatewayUrl,
			this._connectionOptions.ISAUrl,
			this._connectionOptions.zoneId,
			this._connectionOptions.serverId
		)

		this._quantel.monitorServerStatus((_connected: boolean) => {
			this._connectionChanged()
		})

		return true
	}

	/**
	 * Terminates the device safely such that things can be garbage collected.
	 */
	async terminate (): Promise<boolean> {
		this._quantel.dispose()
		this._doOnTime.dispose()

		return true
	}

	/**
	 * Generates an array of Quantel commands by comparing the newState against the oldState, or the current device state.
	 */
	handleState (newState: TimelineState) {
		// check if initialized:
		if (!this._quantel.initialized) {
			this.emit('warning', 'Quantel not initialized yet')
			return
		}

		let previousStateTime = Math.max(this.getCurrentTime(), newState.time)

		let oldQuantelState: QuantelState = (
			this.getStateBefore(previousStateTime) ||
			{ state: { time: 0, port: {} } }
		).state

		let newQuantelState = this.convertStateToQuantel(newState)
		// let oldQuantelState = this.convertStateToQuantel(oldState)

		let commandsToAchieveState = this._diffStates(oldQuantelState, newQuantelState, newState.time)

		// clear any queued commands later than this time:
		this._doOnTime.clearQueueNowAndAfter(previousStateTime)

		// add the new commands to the queue:
		this._addToQueue(commandsToAchieveState)

		// store the new state, for later use:
		this.setState(newQuantelState, newState.time)
	}

	/**
	 * Clear any scheduled commands after this time
	 * @param clearAfterTime
	 */
	clearFuture (clearAfterTime: number) {
		this._doOnTime.clearQueueAfter(clearAfterTime)
	}
	get canConnect (): boolean {
		return true
	}
	get connected (): boolean {
		return this._quantel.connected
	}

	get deviceType () {
		return DeviceType.QUANTEL
	}
	get deviceName (): string {
		return `Quantel ${this._quantel.ISAUrl}/${this._quantel.zoneId}/${this._quantel.serverId}`
	}

	get queue () {
		return this._doOnTime.getQueue()
	}

	/**
	 * Takes a timeline state and returns a Quantel State that will work with the state lib.
	 * @param timelineState The timeline state to generate from.
	 */
	convertStateToQuantel (timelineState: TimelineState): QuantelState {

		const state: QuantelState = {
			time: timelineState.time,
			port: {}
		}
		// create ports from mappings:
		const mappings = this.getMapping()
		_.each(mappings, (mapping) => {
			if (
				mapping &&
				mapping.device === DeviceType.QUANTEL &&
				_.has(mapping,'portId') &&
				_.has(mapping,'channelId')
			) {

				const qMapping: MappingQuantel = mapping as MappingQuantel

				if (!state.port[qMapping.portId]) {
					state.port[qMapping.portId] = {
						channels: [],
						timelineObjId: '',
						mode: qMapping.mode || QuantelControlMode.QUALITY
					}
				}
				const port: QuantelStatePort = state.port[qMapping.portId]

				port.channels = _.sortBy(_.uniq(
					port.channels.concat([qMapping.channelId])
				))
			}
		})

		_.each(timelineState.layers, (layer: ResolvedTimelineObjectInstance, layerName: string) => {

			let foundMapping: Mapping = mappings[layerName]

			if (
				foundMapping &&
				foundMapping.device === DeviceType.QUANTEL &&
				_.has(foundMapping,'portId') &&
				_.has(foundMapping,'channelId')
			) {

				const mapping: MappingQuantel = foundMapping as MappingQuantel

				const port: QuantelStatePort = state.port[mapping.portId]
				if (!port) throw new Error(`Port "${mapping.portId}" not found`)

				if (layer.content && layer.content.title) {
					const clip = layer as any as TimelineObjQuantelClip

					port.timelineObjId = layer.id
					port.clip = {
						title: clip.content.title,
						// clipId // set later

						pauseTime: clip.content.pauseTime,
						playing: clip.content.playing !== undefined ? clip.content.playing : true,

						inPoint: clip.content.inPoint,
						length: clip.content.length,

						playTime:		(
							clip.content.noStarttime
							?
							null :
							layer.instance.start
						) || null
					}
				}
			}
		})

		return state

	}

	/**
	 * Prepares the physical device for playout.
	 * @param okToDestroyStuff Whether it is OK to do things that affects playout visibly
	 */
	async makeReady (okToDestroyStuff?: boolean): Promise<void> {

		if (okToDestroyStuff) {
			// release and re-claim all ports:
			// TODO
		}
		// reset our own state(s):
		if (okToDestroyStuff) {
			this.clearStates()
		}
	}
	getStatus (): DeviceStatus {
		return {
			statusCode: this._quantel.connected ? StatusCode.GOOD : StatusCode.BAD,
			messages: this._quantel.statusMessage ? [this._quantel.statusMessage] : []
		}
	}

	private _diffStates (oldState: QuantelState, newState: QuantelState, time: number): Array<QuantelCommand> {
		const commands: QuantelCommand[] = []

		/** The time of when to run "preparation" commands */
		const prepareTime = Math.min(
			time,
			Math.max(
				time - IDEAL_PREPARE_TIME,
				oldState.time + PREPARE_TIME_WAIT // earliset possible prepareTime
			)
		)

		_.each(newState.port, (newPort: QuantelStatePort, portId: string) => {
			const oldPort = oldState.port[portId]

			if (
				!oldPort ||
				!_.isEqual(newPort.channels, oldPort.channels)
			) {
				const channel: number = newPort.channels[0]
				if (channel) { // todo: support for multiple channels
					commands.push({
						type: QuantelCommandType.SETUPPORT,
						time: prepareTime,
						portId: portId,
						timelineObjId: newPort.timelineObjId,
						channel: channel
					})
				}
			}

			if (
				!oldPort ||
				!_.isEqual(newPort.clip, oldPort.clip)
			) {
				if (newPort.clip) {
					// Load (and play) the clip:

					commands.push({
						type: QuantelCommandType.LOADCLIPFRAGMENTS,
						time: prepareTime,
						portId: portId,
						timelineObjId: newPort.timelineObjId,
						clip: newPort.clip,
						timeOfPlay: time
					})
					if (newPort.clip.playing) {
						commands.push({
							type: QuantelCommandType.PLAYCLIP,
							time: time,
							portId: portId,
							timelineObjId: newPort.timelineObjId,
							clip: newPort.clip,
							mode: newPort.mode
						})
					} else {
						commands.push({
							type: QuantelCommandType.PAUSECLIP,
							time: time,
							portId: portId,
							timelineObjId: newPort.timelineObjId,
							clip: newPort.clip,
							mode: newPort.mode
						})
					}
				} else {
					commands.push({
						type: QuantelCommandType.CLEARCLIP,
						time: time,
						portId: portId,
						timelineObjId: newPort.timelineObjId
					})
				}
			}
		})

		_.each(oldState.port, (oldPort: QuantelStatePort, portId: string) => {
			const newPort = newState.port[portId]
			if (!newPort) {
				// removed port
				commands.push({
					type: QuantelCommandType.RELEASEPORT,
					time: prepareTime,
					portId: portId,
					timelineObjId: oldPort.timelineObjId
				})
			}
		})

		return commands
	}
	private _doCommand (command: QuantelCommand, context: string, timlineObjId: string): Promise<void> {
		let time = this.getCurrentTime()
		return this._commandReceiver(time, command, context, timlineObjId)
	}
	/**
	 * Use either AMCP Command Scheduling or the doOnTime to execute commands at
	 * {@code time}.
	 * @param commandsToAchieveState Commands to be added to queue
	 * @param time Point in time to send commands at
	 */
	private _addToQueue (commandsToAchieveState: Array<QuantelCommand>) {
		_.each(commandsToAchieveState, (cmd: QuantelCommand) => {
			this._doOnTime.queue(cmd.time, cmd.portId, (c: {cmd: QuantelCommand}) => {
				return this._doCommand(c.cmd, c.cmd.type + '_' + c.cmd.timelineObjId, c.cmd.timelineObjId)
			}, { cmd: cmd })
		})

	}
	/**
	 * Sends commands to the Quantel ISA server
	 * @param time deprecated
	 * @param cmd Command to execute
	 */
	private async _defaultCommandReceiver (time: number, cmd: QuantelCommand, context: string, timelineObjId: string): Promise<any> {
		time = time

		let cwc: CommandWithContext = {
			context: context,
			timelineObjId: timelineObjId,
			command: cmd
		}
		this.emit('debug', cwc)

		try {

			if (cmd.type === QuantelCommandType.SETUPPORT) {
				await this._quantelManager.setupPort(cmd)
			} else if (cmd.type === QuantelCommandType.RELEASEPORT) {
				await this._quantelManager.releasePort(cmd)
			} else if (cmd.type === QuantelCommandType.LOADCLIPFRAGMENTS) {
				await this._quantelManager.loadClipFragments(cmd)
			} else if (cmd.type === QuantelCommandType.PLAYCLIP) {
				await this._quantelManager.playClip(cmd)
			} else if (cmd.type === QuantelCommandType.PAUSECLIP) {
				await this._quantelManager.pauseClip(cmd)
			} else if (cmd.type === QuantelCommandType.CLEARCLIP) {
				await this._quantelManager.clearClip(cmd)
				this.getCurrentTime()
			} else {
				// @ts-ignore never
				throw new Error(`Unsupported command type "${cmd.type}"`)
			}
		} catch (error) {
			let errorString = (
				error && error.message ?
				error.message :
				error.toString()
			)
			this.emit('commandError', new Error(errorString), cwc)
		}
	}
	private _connectionChanged () {
		this.emit('connectionChanged', this.getStatus())
	}
}
class QuantelManager {
	private _quantelState: QuantelTrackedState = {
		clipId: {},
		port: {}
	}
	private _cache = new Cache()
	constructor (
		private _quantel: QuantelGateway,
		private getCurrentTime: () => number
	) {}

	public async setupPort (cmd: QuantelCommandSetupPort): Promise<void> {
		const trackedPort = this._quantelState.port[cmd.portId]

		// Check if the port is already set up
		if (
			!trackedPort ||
			trackedPort.channel !== cmd.channel
		) {
			// setup a port and connect it to a channel
			const port = await this._quantel.getPort(cmd.portId)
			if (port) {
				// port already exists, release it first:
				await this._quantel.releasePort(cmd.portId)
			}
			await this._quantel.createPort(cmd.portId, cmd.channel)

			// Store to the local tracking state:
			this._quantelState.port[cmd.portId] = {
				loadedFragments: {},
				offset: 0,
				playing: false,
				jumpOffset: null,
				scheduledStop: null,
				channel: cmd.channel
			}
		}
	}
	public async releasePort (cmd: QuantelCommandReleasePort): Promise<void> {
		try {
			await this._quantel.releasePort(cmd.portId)
		} catch (e) {
			if (e.status !== 404) { // releasing a non-existent port is OK
				throw e
			}
		}
		// Store to the local tracking state:
		delete this._quantelState.port[cmd.portId]
	}
	public async loadClipFragments (cmd: QuantelCommandLoadClipFragments): Promise<void> {

		const trackedPort = this.getTrackedPort(cmd.portId)

		const server = await this.getServer()

		let clipId = await this.getClipId(cmd.clip)
		const clipData = await this._quantel.getClip(clipId)
		if (!clipData) throw new Error(`Clip ${clipId} not found`)
		if (!clipData.PoolID) throw new Error(`Clip ${clipData.ClipID} missing PoolID`)

		// Check that the clip is present on the server:
		if ((server.pools || []).indexOf(clipData.PoolID) === -1) {
			throw new Error(`Clip "${clipData.ClipID}" PoolID ${clipData.PoolID} not found on server (${server.ident})`)
		}

		let useInOutPoints: boolean = !!(
			cmd.clip.inPoint ||
			cmd.clip.length
		)

		let inPoint = cmd.clip.inPoint
		let length = cmd.clip.length

		/** In point [frames] */
		const inPointFrames: number = (
			inPoint ?
			Math.round(inPoint * DEFAULT_FPS / 1000) : // todo: handle fps, get it from clip?
			0
		) || 0

		/** Duration [frames] */
		let lengthFrames: number = (
			length ?
			Math.round(length * DEFAULT_FPS / 1000) : // todo: handle fps, get it from clip?
			0
		) || parseInt(clipData.Frames, 10) || 0

		if (inPoint && !length) {
			lengthFrames -= inPointFrames
		}

		const outPointFrames = inPointFrames + lengthFrames

		let portInPoint: number
		let portOutPoint: number
		// Check if the fragments are already loaded on the port?
		const loadedFragments = trackedPort.loadedFragments[clipId]
		if (
			loadedFragments &&
			loadedFragments.inPoint === inPointFrames &&
			loadedFragments.outPoint === outPointFrames
		) {
			// Reuse the already loaded fragment:
			portInPoint = loadedFragments.portInPoint
			portOutPoint = loadedFragments.portOutPoint
		} else {
			// Fetch fragments of clip:
			const fragmentsInfo = await (
				useInOutPoints ?
				this._quantel.getClipFragments(clipId, inPointFrames, outPointFrames) :
				this._quantel.getClipFragments(clipId)
			)

			// Check what the end-frame of the port is:
			const portStatus = await this._quantel.getPort(cmd.portId)
			if (!portStatus) throw new Error(`Port ${cmd.portId} not found`)
			// Load the fragments onto Port:
			portInPoint = portStatus.endOfData || 0
			const newPortStatus = await this._quantel.loadFragmentsOntoPort(cmd.portId, fragmentsInfo.fragments, portInPoint)
			if (!newPortStatus) throw new Error(`Port ${cmd.portId} not found after loading fragments`)
			portOutPoint = portInPoint + fragmentsInfo.fragments.reduce((x, y) => x > y.finish ? x : y.finish, 0) - 1 // newPortStatus.endOfData - 1

			// Store a reference to the beginning of the fragments:
			trackedPort.loadedFragments[clipId] = {
				portInPoint: portInPoint,
				portOutPoint: portOutPoint,
				inPoint: inPointFrames,
				outPoint: outPointFrames
			}
		}
		// Prepare the jump?
		let timeLeftToPlay = cmd.timeOfPlay - this.getCurrentTime()
		if (timeLeftToPlay > 0) { // We have time to prepare the jump

			if (portInPoint > 0 && trackedPort.scheduledStop === null) {
				// Since we've now added fragments to the end of the port timeline, we should make sure it'll stop at the previous end
				await this._quantel.portStop(cmd.portId, portInPoint - 1)
				trackedPort.scheduledStop = portInPoint - 1
			}

			await this._quantel.portPrepareJump(cmd.portId, portInPoint)
			// Store the jump in the tracked state:
			trackedPort.jumpOffset = portInPoint
		}
	}
	public async playClip (cmd: QuantelCommandPlayClip): Promise<void> {
		await this.prepareClipJump(cmd, 'play')
	}
	public async pauseClip (cmd: QuantelCommandPauseClip): Promise<void> {
		await this.prepareClipJump(cmd, 'pause')
	}
	public async clearClip (cmd: QuantelCommandClearClip): Promise<void> {
		const trackedPort = this.getTrackedPort(cmd.portId)
		await this._quantel.portClear(cmd.portId)

		trackedPort.jumpOffset = null
		trackedPort.loadedFragments = {}
		trackedPort.scheduledStop = null
	}
	private async prepareClipJump (cmd: QuantelCommandClip, alsoDoAction?: 'play' | 'pause'): Promise<void> {
		// fetch tracked reference to the loaded clip:
		const trackedPort = this.getTrackedPort(cmd.portId)

		const clipId = await this.getClipId(cmd.clip)
		const loadedFragments = trackedPort.loadedFragments[clipId]

		if (!loadedFragments) {
			// huh, the fragments hasn't been loaded
			throw new Error(`Fragments of clip ${clipId} wasn't loaded`)
		}
		const clipFps = DEFAULT_FPS // todo: handle fps, get it from clip?
		const jumpToOffset = Math.floor(
			loadedFragments.portInPoint + (
				cmd.clip.playTime ?
				Math.max(0, (cmd.clip.pauseTime || this.getCurrentTime()) - cmd.clip.playTime) * clipFps / 1000 :
				0
			)
		)
		if (
			trackedPort.jumpOffset &&
			Math.abs(trackedPort.jumpOffset - jumpToOffset) > JUMP_ERROR_MARGIN
		) {
			// It looks like the stored jump is no longer valid
			// Invalidate stored jump:
			trackedPort.jumpOffset = null
		}
		// Jump the port playhead to the correct place
		if (trackedPort.jumpOffset !== null) {
			// Good, there is a prepared jump
			if (alsoDoAction === 'pause') {
				// Pause the playback:
				await this._quantel.portStop(cmd.portId)
				trackedPort.scheduledStop = null
				trackedPort.playing = false
			}
			// Trigger the jump:
			await this._quantel.portTriggerJump(cmd.portId)
			trackedPort.offset = trackedPort.jumpOffset
		} else {
			// No jump has been prepared
			if (cmd.mode === QuantelControlMode.QUALITY) {
				// Prepare a soft jump:
				await this._quantel.portPrepareJump(cmd.portId, jumpToOffset)
				trackedPort.jumpOffset = jumpToOffset

				// Allow the server some time to load the clip:
				await this.wait(SOFT_JUMP_WAIT_TIME) // This is going to

				if (alsoDoAction === 'pause') {
					// Pause the playback:
					await this._quantel.portStop(cmd.portId)
					trackedPort.scheduledStop = null
					trackedPort.playing = false
				}

				// Trigger the jump:
				await this._quantel.portTriggerJump(cmd.portId)
				trackedPort.offset = trackedPort.jumpOffset

			} else { // cmd.mode === QuantelControlMode.SPEED
				// Just do a hard jump:
				this._quantel.portHardJump(cmd.portId, jumpToOffset)

				trackedPort.offset = jumpToOffset
				trackedPort.playing = false
			}
		}

		if (alsoDoAction === 'play') {
			// Start playing:
			await this._quantel.portPlay(cmd.portId)
			trackedPort.scheduledStop = null
			trackedPort.playing = true

			// Schedule the port to stop at the last frame of the clip
			if (loadedFragments.portOutPoint) {
				await this._quantel.portStop(cmd.portId, loadedFragments.portOutPoint)
				trackedPort.scheduledStop = loadedFragments.portOutPoint
			}
		}
	}
	private getTrackedPort (portId: string): QuantelTrackedStatePort {
		const trackedPort = this._quantelState.port[portId]
		if (!trackedPort) {
			// huh, it looks like the port hasn't been created yet.
			// This is strange, it should have been created by a previously run SETUPPORT
			throw new Error(`Port ${portId} missing in tracked quantel state`)
		}
		return trackedPort
	}
	private async getServer () {
		const server = await this._quantel.getServer()
		if (!server) throw new Error(`Quantel server ${this._quantel.serverId} not found`)
		if (!server.pools) throw new Error(`Server ${server.ident} has no .pools`)
		if (!server.pools.length) throw new Error(`Server ${server.ident} has an empty .pools array`)

		return server
	}
	private async getClipId (clip: QuantelStatePortClip): Promise<number> {
		let clipId = clip.clipId

		if (!clipId && clip.title) {

			clipId = await this._cache.getSet(`clip.${clip.title}.clipId`, async () => {

				const server = await this.getServer()

				// Look up the clip:
				const foundClips = await this._quantel.searchClip({
					Title: clip.title
				})
				const foundClip = _.find(foundClips, (clip) => {
					return (
						clip.PoolID &&
						(server.pools || []).indexOf(clip.PoolID) !== -1
					)
				})
				if (!foundClip) throw new Error(`Clip "${clip.title}" not found on server (${server.ident})`)

				// Store to tracked state:
				this._quantelState.clipId[clip.title] = foundClip.ClipID

				return foundClip.ClipID
			})
		}
		if (!clipId) throw new Error(`Unable to determine clipId for clip '${clip.title}'`)

		return clipId
	}
	private wait (time: number) {
		return new Promise(resolve => {
			setTimeout(resolve, time)
		})
	}
}
class Cache {
	private data: {[key: string]: {
		endTime: number
		value: any
	}} = {}
	private callCount: number = 0
	set (key: string, value: any, ttl: number = 30000): any {
		this.data[key] = {
			endTime: Date.now() + ttl,
			value: value
		}
		this.callCount++
		if (this.callCount > 100) {
			this.callCount = 0
			this._triggerClean()
		}
		return value
	}
	get (key: string): any | undefined {
		const o = this.data[key]
		if (o && (o.endTime || 0) >= Date.now()) return o.value
	}
	exists (key: string): boolean {
		const o = this.data[key]
		return (o && (o.endTime || 0) >= Date.now())
	}
	getSet<T extends any> (key, fcn: () => T, ttl?: number): T {
		if (this.exists(key)) {
			return this.get(key)
		} else {
			let value = fcn()
			if (value && _.isObject(value) && _.isFunction(value.then)) {
				// value is a promise
				return (
					Promise.resolve(value)
					.then((value) => {
						return this.set(key, value, ttl)
					})
				) as any as T
			} else {
				return this.set(key, value, ttl)
			}
		}
	}
	private _triggerClean () {
		setTimeout(() => {
			_.each(this.data, (o, key) => {
				if ((o.endTime || 0) < Date.now()) {
					delete this.data[key]
				}
			})
		}, 1)
	}
}

interface QuantelState {
	time: number
	port: {
		[portId: string]: QuantelStatePort
	}
}
interface QuantelStatePort {
	timelineObjId: string
	clip?: QuantelStatePortClip
	mode: QuantelControlMode

	channels: number[]
}
interface QuantelStatePortClip {
	title: string
	clipId?: number

	playing: boolean
	playTime: number | null
	pauseTime?: number

	inPoint?: number
	length?: number
}

interface QuantelCommandBase {
	time: number
	type: QuantelCommandType
	portId: string
	timelineObjId: string
}
export enum QuantelCommandType {
	SETUPPORT = 'setupPort',
	LOADCLIPFRAGMENTS = 'loadClipFragments',
	PLAYCLIP = 'playClip',
	PAUSECLIP = 'pauseClip',
	CLEARCLIP = 'clearClip',
	RELEASEPORT = 'releasePort'
}
interface QuantelCommandSetupPort extends QuantelCommandBase {
	type: QuantelCommandType.SETUPPORT
	channel: number // todo later: support for multiple channels
}
interface QuantelCommandLoadClipFragments extends QuantelCommandBase {
	type: QuantelCommandType.LOADCLIPFRAGMENTS
	clip: QuantelStatePortClip
	/** The time the clip is scheduled to play */
	timeOfPlay: number
}
interface QuantelCommandClip extends QuantelCommandBase {
	clip: QuantelStatePortClip
	mode: QuantelControlMode
}
interface QuantelCommandPlayClip extends QuantelCommandClip {
	type: QuantelCommandType.PLAYCLIP
}
interface QuantelCommandPauseClip extends QuantelCommandClip {
	type: QuantelCommandType.PAUSECLIP
}
interface QuantelCommandClearClip extends QuantelCommandBase {
	type: QuantelCommandType.CLEARCLIP
}
interface QuantelCommandReleasePort extends QuantelCommandBase {
	type: QuantelCommandType.RELEASEPORT

}

type QuantelCommand = QuantelCommandSetupPort |
	QuantelCommandLoadClipFragments |
	QuantelCommandPlayClip |
	QuantelCommandPauseClip |
	QuantelCommandClearClip |
	QuantelCommandReleasePort

/** Tracked state of an ISA-Zone-Server entity */
interface QuantelTrackedState {
	clipId: {
		[title: string]: number
	}
	port: {
		[portId: string]: QuantelTrackedStatePort
	}
}
interface QuantelTrackedStatePort {
	/** Reference to the latest loaded fragments of a clip  */
	loadedFragments: {
		[clipId: number]: {
			/** The point (in a port) where the fragments starts [frames] */
			portInPoint: number
			/** The point (in a port) where the fragments ends [frames] */
			portOutPoint: number

			/** The inpoint used when loading the fragments */
			inPoint: number
			/** The outpoint used when loading the fragments */
			outPoint: number
		}
	},
	channel: number

	offset: number
	playing: boolean
	jumpOffset: number | null
	scheduledStop: number | null
}
