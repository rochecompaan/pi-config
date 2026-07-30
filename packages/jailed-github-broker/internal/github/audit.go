package github

// ValidatedRefNames returns only ref-like names that Parse already validated.
func ValidatedRefNames(request Request) []string {
	var refs []string
	switch args := request.arguments.(type) {
	case prListArgs:
		refs = appendNonempty(refs, args.Base, args.Head)
	case prCreateArgs:
		refs = appendNonempty(refs, args.Head, args.Base)
	case prUpdateArgs:
		if args.Base != nil {
			refs = appendNonempty(refs, *args.Base)
		}
	case runListArgs:
		refs = appendNonempty(refs, args.Branch)
	}
	return refs
}

func appendNonempty(refs []string, values ...string) []string {
	for _, value := range values {
		if value != "" {
			refs = append(refs, value)
		}
	}
	return refs
}
