import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import fs from 'fs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';


const files = fileURLToPath(new URL('./files', import.meta.url).href);


/** @type {import('./index.js').default} */
export default function (opts = {}) {
	const { out = 'build', precompress, envPrefix = '' } = opts;

	return {
		name: '@sveltejs/adapter-node',

		async adapt(builder) {
			const tmp = builder.getBuildDirectory('adapter-node');
			const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
				
			builder.mkdirp(out);
			if(fs.existsSync(`${out}/${pkg.name}`)) 
			{
				builder.rimraf(out);
				builder.rimraf(tmp);
				builder.mkdirp(tmp);
				
			}	
			builder.mkdirp(out);
			if(!fs.existsSync(`${out}/web.config`)) 
				await fs.promises.copyFile(`${files}/web.config`, `${out}/web.config`);
				
			let config = readFileSync(`${out}/web.config`, 'utf8')
				.replace('</handlers>', `<add name="${pkg.name}" path="${pkg.name}/index.js" verb="*" modules="iisnode" />\n</handlers>`);

			const rule = `<rule name="Dynamic${pkg.name}" stopProcessing="true">
                    <match url="${builder.config.kit.paths.base??""}(.*)" />
                    <conditions>
                        <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="True" />
                    </conditions>
                    <action type="Rewrite" url="${pkg.name}/index.js" />
                </rule>`

			if(builder.config.kit.paths.base)
				config = config.replace('<rules>','<rules>' + '\n' + rule );
			else
				config = config.replace('</rules>',rule+'\n</rules>'  );

			writeFileSync(`${out}/web.config`, config);	
			console.time(pkg.name);

			builder.log.minor('Copying assets');
			builder.writeClient(`${out}/client${builder.config.kit.paths.base}`);
			//builder.writePrerendered(`${out}/prerendered${builder.config.kit.paths.base}`);

			if (precompress) {
				builder.log.minor('Compressing assets');
				await Promise.all([
					builder.compress(`${out}/client`),
					builder.compress(`${out}/prerendered`)
				]);
			}

			builder.log.minor('Building server');

			builder.writeServer(tmp);

			writeFileSync(
				`${tmp}/manifest.js`,
				[
					`export const manifest = ${builder.generateManifest({ relativePath: './' })};`,
					`export const base = ${JSON.stringify(builder.config.kit.paths.base)};`
				].join('\n\n')
			);

			

			// we bundle the Vite output so that deployments only need
			// their production dependencies. Anything in devDependencies
			// will get included in the bundled code
			const bundle = await rollup({
				cache: true,
				perf: true,
				treeshake: "smallest",
				input: {
					index: `${tmp}/index.js`,
					manifest: `${tmp}/manifest.js`,
				},
				onwarn: (message) => {
					if (message.code === 'CIRCULAR_DEPENDENCY') {
						return;
					}
					if (message.code === 'PLUGIN_WARNING') {
						return;
					}
					console.error(message);
				},
				context: 'global',
				external: [
					// dependencies could have deep exports, so we need a regex
					...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`))
				],
				plugins: [
					nodeResolve({
						preferBuiltins: true,
						exportConditions: ['node']
					}),
					terser({
						mangle: false,
						keep_classnames: true,
						maxWorkers: 4,
						format:{
							comments:false
						}
					}),
					// @ts-ignore https://github.com/rollup/plugins/issues/1329
					commonjs({ strictRequires: true }),
					// @ts-ignore https://github.com/rollup/plugins/issues/1329
					json()
				]
			});

			await bundle.write({
				dir: `${out}/${pkg.name}/server`,
				format: 'esm',
				sourcemap: false,
				chunkFileNames: '[name].js',
				manualChunks: () => 'server',
				banner: `import { URL as URL_DIR } from 'url';\nconst __dirname = new URL_DIR('.', import.meta.url).pathname;\n`
			});

			builder.copy(files, `${out}/${pkg.name}`, {
				filter: (file) => file !== 'web.config',
				replace: {
					ENV: './env.js',
					HANDLER: './handler.js',
					MANIFEST: './server/manifest.js',
					SERVER: './server/index.js',
					SHIMS: './shims.js',
					ENV_PREFIX: JSON.stringify(envPrefix)
				}
			});
			const package_path = `${out}/package.json`;

			let package_json = fs.existsSync(package_path) ? JSON.parse(fs.readFileSync(package_path, 'utf8')) : { type: "module", dependencies: {} };

			// Merge the new dependencies with the existing ones
			package_json.dependencies = {
				...package_json.dependencies,  // Existing dependencies
				...pkg.dependencies           // New dependencies to merge
			};

			// Write the new package.json
			fs.writeFileSync(package_path, JSON.stringify(package_json, null, 2));

			console.timeEnd(pkg.name);
		},

		supports: {
			read: () => true
		}
	};
}
