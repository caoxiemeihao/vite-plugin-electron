import {
  type Plugin,
  build as viteBuild,
} from 'vite'
import {
  resolveServerUrl,
  resolveViteConfig,
  withExternalBuiltins,
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

  /**
   * It is up to the developer to decide whether to use treeKill
   *
   * @example
   *
   * package.json
   * // use TreeKill, please add tree-kill in devDependencies
   * "tree-kill": "^1.2.2"
   *
   * @defaule `false` treeKill is not used by default
   */
  useTreeKill?: boolean
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
          for (const options of optionsArray) {
            options.vite ??= {}
            options.vite.mode ??= server.config.mode
            options.vite.build ??= {}
            options.vite.build.watch ??= {}
            options.vite.build.minify ??= false
            options.vite.plugins ??= []
            startup.useTreeKill = !!options.useTreeKill
            options.vite.plugins.push(
              {
                name: ':startup',
                closeBundle() {
                  if (options.onstart) {
                    options.onstart.call(this, {
                      startup,
                      reload() {
                        server.ws.send({ type: 'full-reload' })
                      },
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

  startup.exit()
  // Start Electron.app
  process.electronApp = spawn(electronPath, argv, { stdio: 'inherit' })
  // Exit command after Electron.app exits
  process.electronApp.once('exit', process.exit)

  if (!startup.hookProcessExit) {
    startup.hookProcessExit = true
    process.once('exit', startup.exit)
  }
}

startup.hookProcessExit = false
startup.useTreeKill = false

startup.exit = async () => {
  if (!process.electronApp) {
    return
  }

  process.electronApp.removeAllListeners()

  if (startup.useTreeKill) {
    const { default: treeKill } = await import("tree-kill")
    treeKill(process.electronApp.pid!)
    return;
  }

  process.electronApp.kill()
}
