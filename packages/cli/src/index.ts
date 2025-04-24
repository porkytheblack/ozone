import { program } from "commander"
import simpleGit from 'simple-git'
import degit from 'degit'
import path from "path"

program.name("ozone-cli")
    .description("Cli tool for interacting with ozone")
    .version("0.0.1")

program.command("init")
    .argument('<directory>', 'Target directory to create the project in', '.')
    .option('-n, --name <project_name>', 'Project Name', 'ozone-agents')
    .action(async (directory, opts) => {
        try {
            const name = opts.name ? opts.name : ''
            const target = path.resolve(process.cwd(), directory, name)

            const emitter = degit("github:porkytheblack/ozone/packages/scaffold", {
                cache: false,
                force: true,
            })
            await emitter.clone(target)

            const git = simpleGit(target)
            await git.init()
            await git.add("./*")
            await git.commit("chore: initial commit")

            console.log(`✓ Project created in ${target}`)
        }
        catch (e) {
            console.log(`Something went wrong while setting up the directory ::`, e)
        }
    });

program.parse()