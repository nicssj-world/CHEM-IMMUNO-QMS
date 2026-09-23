export type BootstrapArguments = {
  ephisId: string;
  displayName: string;
  passwordFromStdin: boolean;
  allowLocal: boolean;
  productionRollout: boolean;
};

export function parseBootstrapArguments(args: string[]): BootstrapArguments {
  const values = new Map<string,string>();
  let passwordFromStdin = false;
  let allowLocal = false;
  let productionRollout = false;
  for (let index=0; index<args.length; index++) {
    const name=args[index];
    if (name==='--password') {
      throw new Error('Password arguments are refused because shells and npm may echo them; use --password-stdin or CI_BOOTSTRAP_PASSWORD.');
    }
    if (name==='--password-stdin') {
      if (passwordFromStdin) throw new Error('Duplicate bootstrap option.');
      passwordFromStdin=true;
      continue;
    }
    if (name==='--allow-local') {
      if (allowLocal) throw new Error('Duplicate bootstrap option.');
      allowLocal=true;
      continue;
    }
    if (name==='--production-rollout') {
      if (productionRollout) throw new Error('Duplicate bootstrap option.');
      productionRollout=true;
      continue;
    }
    if ((name==='--ephis' || name==='--name') && args[index+1] && !args[index+1].startsWith('--')) {
      const key=name.slice(2);
      if (values.has(key)) throw new Error('Duplicate bootstrap option.');
      values.set(key,args[++index]);
      continue;
    }
    throw new Error('Invalid bootstrap option. Use --ephis, --name, --password-stdin, and optionally --allow-local or --production-rollout.');
  }
  const ephisId=values.get('ephis');
  const displayName=values.get('name');
  if (!ephisId || !displayName) throw new Error('Provide --ephis and --name.');
  if (passwordFromStdin && process.env.CI_BOOTSTRAP_PASSWORD) throw new Error('Use either password stdin or CI_BOOTSTRAP_PASSWORD, not both.');
  if (allowLocal && productionRollout) throw new Error('Use only one bootstrap target mode: --allow-local or --production-rollout.');
  return { ephisId, displayName, passwordFromStdin, allowLocal, productionRollout };
}
