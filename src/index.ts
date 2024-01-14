import {
  type Plugin,
  build as viteBuild,
} from 'vite'
import {
  resolveServerUrl,
  resolveViteConfig,
  withExternalBuiltins,
  calcEntryCount,
} from './utils'

// public utils
export {
  resolveViteConfig,
  withExternalBuiltins,
}

export interface ElectronOptions {
  /**
   * Shortcut of `build.lib.entry`
   */
  entry?: import('vite').LibraryOptions['entry']
  vite?: import('vite').InlineConfig
  /**
   * Triggered when Vite is built every time -- `vite serve` command only.
   *
   * If this `onstart` is passed, Electron App will not start automatically.
   * However, you can start Electroo App via `startup` function.
   */
  onstart?: (args: {
    /**
     * Electron App startup function.
     * It will mount the Electron App child-process to `process.electronApp`.
     * @param argv default value `['.', '--no-sandbox']`
     */
    startup: (argv?: string[]) => Promise<void>
    /** Reload Electron-Renderer */
    reload: () => void
  }) => void | Promise<void>
}

export function build(options: ElectronOptions) {
  return viteBuild(withExternalBuiltins(resolveViteConfig(options)))
}

export default function electron(options: ElectronOptions | ElectronOptions[]): Plugin[] {
  const optionsArray = Array.isArray(options) ? options : [options]
  let mode: string

  return [
    {
      name: 'vite-plugin-electron',
      apply: 'serve',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          Object.assign(process.env, {
            VITE_DEV_SERVER_URL: resolveServerUrl(server),
          })

          const entryCount = calcEntryCount(optionsArray)
          let closeBundleCount = 0

          for (const options of optionsArray) {
            options.vite ??= {}
            options.vite.mode ??= server.config.mode
            options.vite.build ??= {}
            options.vite.build.watch ??= {}
            options.vite.build.minify ??= false
            options.vite.plugins ??= []
            options.vite.plugins.push(
              {
                name: ':startup',
                closeBundle() {
                  if (++closeBundleCount < entryCount) return

                  if (options.onstart) {
                    options.onstart.call(this, {
                      startup,
                      reload: process.electronApp
                        ? () => server.ws.send({ type: 'full-reload' })
                        : startup,
                    })
                  } else {
                    startup()
                  }
                },
              },
            )
            build(options)
          }
        })
      },
    },
    {
      name: 'vite-plugin-electron',
      apply: 'build',
      config(config, env) {
        // Make sure that Electron can be loaded into the local file using `loadFile` after packaging.
        config.base ??= './'
        mode = env.mode
      },
      async closeBundle() {
        for (const options of optionsArray) {
          options.vite ??= {}
          options.vite.mode ??= mode
          await build(options)
        }
      }
    },
  ]
}

/**
 * Electron App startup function.
 * It will mount the Electron App child-process to `process.electronApp`.
 * @param argv default value `['.', '--no-sandbox']`
 */
export async function startup(argv = ['.', '--no-sandbox']) {
  const { spawn } = await import('node:child_process')
  // @ts-ignore
  const electron = await import('electron')
  const electronPath = <any>(electron.default ?? electron)

  await startup.exit()

  // Start Electron.app
  process.electronApp = spawn(electronPath, argv, { stdio: 'inherit' })

  // Exit command after Electron.app exits
  process.electronApp.once('exit', process.exit)

  if (!startup.hookedProcessExit) {
    startup.hookedProcessExit = true
    process.once('exit', async () => {
      await startup.exit()
      // When the process exits, `tree-kill` does not have enough time to complete execution, so `electronApp` needs to be killed immediately.
      process.electronApp.kill()
    })
  }
}
startup.hookedProcessExit = false
startup.exit = () => {
  if (!process.electronApp) {
    return Promise.resolve(null)
  }

  process.electronApp.removeAllListeners()

  return new Promise<Error | void>(async resolve => {
    await import('tree-kill')
      .then(m => m.default(
        process.electronApp.pid!,
        'SIGKILL',
        resolve,
      ))
      .catch(e => {
        if (e.code === 'ERR_MODULE_NOT_FOUND') {
          console.log(
            '[vite-plugin-electron]',
            'Please install tree-kill to exit all associated processes, run "npm i tree-kill -D".',
          )
        } else {
          console.error(e)
        }

        process.electronApp.kill()
        resolve(e)
      })
  })
}
