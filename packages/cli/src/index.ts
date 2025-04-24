#!/usr/bin/env node
import { program } from "commander"
import simpleGit from 'simple-git'
import degit from 'degit'
import path from "path"

program.name("ozone-cli")
    .description("Cli tool for interacting with ozone")
    .version("0.0.1")

program.command("init")
    .option('-t, --target <target>', 'Target directory', '.')
    .option('-n, --name <project_name>', 'Project Name', 'ozone-agents')
    .action(async (args, opts) => {
        try {

            const name = args.name ? args.name : ''
            const dir = args.target ? args.target : '.'
            const target = path.resolve(process.cwd(), dir, name)

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