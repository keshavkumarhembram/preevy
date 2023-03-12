import fs from 'fs'
import path from 'path'
import Docker from 'dockerode'
import { inspect } from 'node:util'
import pino from 'pino'
import pinoPretty from 'pino-pretty'
import { EOL } from 'os'
import createDockerClient from './src/docker'
import createWebServer from './src/web'
import { SshState, sshClient as createSshClient, checkConnection, formatPublicKey, parseSshUrl, SshConnectionConfig } from './src/ssh'
import { requiredEnv } from './src/env'
import { tunnelNameResolver } from './src/tunnel-name'
import { ConnectionCheckResult } from './src/ssh/connection-checker'

const sshConnectionConfigFromEnv = (): { connectionConfig: SshConnectionConfig; sshUrl: string } => {
  const sshUrl = requiredEnv('SSH_URL')
  const parsed = parseSshUrl(sshUrl)
  const clientPrivateKey = process.env.SSH_PRIVATE_KEY || fs.readFileSync(
    path.join(process.env.HOME || '/root', '.ssh', 'id_rsa'),
    { encoding: 'utf8' },
  )

  return {
    sshUrl,
    connectionConfig: {
      ...parsed,
      clientPrivateKey,
      username: process.env.USER ?? 'foo',
      knownServerPublicKeys: [process.env.SSH_SERVER_PUBLIC_KEY].filter(Boolean) as string[],
      insecureSkipVerify: Boolean(process.env.INSECURE_SKIP_VERIFY),
      tlsServerName: process.env.TLS_SERVERNAME || undefined,
    },
  }
}

const formatConnectionCheckResult = (
  r: ConnectionCheckResult,
) => {
  if ('unverifiedHostKey' in r) {
    return { unverifiedHostKey: formatPublicKey(r.unverifiedHostKey) }
  }
  if ('error' in r) {
    return { error: r.error.message || r.error.toString(), stack: r.error.stack, details: inspect(r.error) }
  }
  return r
}

const main = async () => {
  const log = pino({
    level: process.env.DEBUG ? 'debug' : 'info',
  }, pinoPretty({ destination: pino.destination(process.stderr) }))

  const { connectionConfig, sshUrl } = sshConnectionConfigFromEnv()

  log.debug('ssh config: %j', {
    ...connectionConfig,
    clientPrivateKey: '*** REDACTED ***',
    clientPublicKey: formatPublicKey(connectionConfig.clientPrivateKey),
  })

  if (process.env.SSH_CHECK_ONLY || process.argv.includes('check')) {
    const result = await checkConnection({
      connectionConfig,
      log: log.child({ name: 'ssh' }, { level: 'warn' }),
    })
    process.stdout.write(JSON.stringify(formatConnectionCheckResult(result)))
    process.stdout.write(EOL)
    process.exit(0)
  }

  const docker = new Docker({ socketPath: '/var/run/docker.sock' })
  const dockerClient = createDockerClient({ log: log.child({ name: 'docker' }), docker, debounceWait: 500 })

  const sshClient = await createSshClient({
    connectionConfig,
    tunnelNameResolver,
    log: log.child({ name: 'ssh' }),
    onError: err => {
      log.error(err)
      process.exit(1)
    },
  })

  log.info('ssh client connected to %j', sshUrl)

  let state: SshState

  const initPromise = new Promise<void>(resolve => {
    void dockerClient.listenToContainers({
      onChange: async services => {
        state = await sshClient.updateTunnels(services)
        process.stdout.write(JSON.stringify(state))
        process.stdout.write(EOL)
        resolve()
      },
    })
  })

  const webServer = createWebServer({
    getSshState: () => initPromise.then(() => state),
  })
    .listen(process.env.PORT ?? 3000, () => {
      log.info(`listening on ${inspect(webServer.address())}`)
    })
    .on('error', err => {
      log.error(err)
      process.exit(1)
    })
    .unref()
}

void main()
