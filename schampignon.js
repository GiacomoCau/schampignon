// An interpreter for a Kernel-like language.
// By Manuel Simoni <msimoni@gmail.com>, August 2011
// In the public domain.

/**** Virtual Machine ****/

function Scm_vm(e) {
	// Accumulator
	this.a = null;
	// neXt instruction
	this.x = null;
	// Environment
	this.e = e;
	// aRguments
	this.r = [];
	// Stack
	this.s = null;
	// Statistics
	this.stat_insns = 0; // number of instructions
}

function Scm_frame(x, e, r, s) {
	this.x = x;
	this.e = e;
	this.r = r;
	this.s = s;
}

/**** Evaluation ****/

function scm_eval(vm, form) {
	scm_compile(vm, form, scm_insn_halt, false);
	while (vm.x(vm)) vm.stat_insns++;
	return vm.a;
}

function scm_compile(vm, form, next, tail) {
	if (scm_is_symbol(form)) {
		vm.a = scm_lookup(vm.e, form);
		vm.x = next;
	}
	else if (scm_is_pair(form)) {
		var combiner = scm_car(form);
		var otree = scm_cdr(form);
		scm_compile(vm, combiner, scm_insn_combine(otree, next, tail), false);
	}
	else {
		vm.a = form;
		vm.x = next;
	}
}

function scm_insn_combine(otree, next, tail) {
	return function(vm) { return vm.a.scm_combine(vm, otree, next, tail); };
}

function scm_insn_halt(vm) {
	return false;
}

/**** Compound Operatives & Applicatives ****/

function Scm_combiner(env, ptree, eformal, body) {
	// Static lexical environment link
	this.env = env;
	// Parameter tree
	this.ptree = ptree;
	// Dynamic lexical environment parameter
	this.eformal = eformal;
	// Body form
	this.body = body;
}

function Scm_wrapper(combiner) {
	// Underlying combiner
	this.combiner = combiner;
}

Scm_combiner.prototype.scm_combine = scm_general_combine;
Scm_wrapper.prototype.scm_combine = scm_general_combine;

function scm_general_combine(vm, otree, next, tail) {
	if (!tail) {
		/* If this call does not appear in tail position, save the
		   current execution state (next instruction, lexical
		   environment, and stack) in a new stack frame, and set up
		   the next instruction to pop (return from) the frame again
		   after the operation, reinstating the saved state and
		   executing the original next instruction.  Note that if this
		   call *does* appear in tail position, it reuses the current
		   frame, and directly executes the next instruction after the
		   operation. */
		vm.s = new Scm_frame(next, vm.e, vm.r, vm.s);
		next = scm_insn_return;
	}
	if (scm_is_applicative(vm.a)) {
		/* For an applicative, we take a detour through argument
		   evaluation.  This ping-pongs between scm_insn_argument_eval
		   and scm_insn_argument_store, destructuring the operand
		   tree, and building up the arguments list, until the operand
		   tree is empty. */
		vm.x = scm_insn_argument_eval(scm_unwrap(vm.a), otree, next);
		vm.r = [];
	}
	else {
		/* For an operative, set the environment to the operator's
		   static lexical environment enriched with bindings from
		   matching the operand tree against the parameter tree, and
		   enter the operative's body expression in tail position. */
		vm.e = scm_extend(vm.a, otree, vm.e);
		scm_compile(vm, vm.a.body, next, true);
	}
	return true;
}

function scm_insn_argument_eval(combiner, otree, next) {
	return function(vm) {
		if (scm_is_nil(otree)) {
			/* After argument evaluation of an original applicative
			   combination, tail-call the new combination, consisting
			   of the applicative's underlying combiner and the
			   arguments (the results of evaluating the elements of
			   the operand tree).  If the original combination was not
			   a tail call, it has created a new frame, which we can
			   reuse.  If the original combination was a tail call,
			   it's the same: just reuse its frame. */
			var combination = scm_cons(combiner, scm_array_to_cons_list(vm.r));
			scm_compile(vm, combination, next, true);
		}
		else {
			next = scm_insn_argument_store(combiner, scm_cdr(otree), next);
			scm_compile(vm, scm_car(otree), next, false);
		}
		return true;
	};
}

function scm_insn_argument_store(combiner, otree, next) {
	return function(vm) {
		vm.r = vm.r.slice(); // HORROR
		vm.r.push(vm.a);
		vm.x = scm_insn_argument_eval(combiner, otree, next);
		return true;
	};
}

function scm_insn_return(vm) {
	vm.x = vm.s.x;
	vm.e = vm.s.e;
	vm.r = vm.s.r;
	vm.s = vm.s.s;
	return true;
}

function scm_wrap(combiner) {
	return new Scm_wrapper(combiner);
}

function scm_unwrap(wrapper) {
	return wrapper.combiner;
}

function scm_is_applicative(combiner) {
	return (combiner instanceof Scm_wrapper);
}

function scm_is_operative(combiner) {
	return !scm_is_applicative(combiner);
}

/**** Built-in Combiners ****/

/* $vau */

function Scm_vau() { }

Scm_vau.prototype.scm_combine = function(vm, otree, next, tail) {
	var ptree = scm_compound_elt(otree, 0);
	var eformal = scm_compound_elt(otree, 1);
	var body = scm_compound_elt(otree, 2);
	vm.a = new Scm_combiner(vm.e, ptree, eformal, body);
	vm.x = next;
	return true;
}

/* $define! */

function Scm_define() { }

Scm_define.prototype.scm_combine = function(vm, otree, next, tail) {
	var ptree = scm_compound_elt(otree, 0);
	var expr = scm_compound_elt(otree, 1);
	scm_compile(vm, expr, scm_insn_define(ptree, vm.e, next), false);
	return true;
}

function scm_insn_define(ptree, env, next) {
	return function(vm) {
		scm_match(env, ptree, vm.a);
		vm.a = scm_inert;
		vm.x = next;
		return true;
	};
}

/* $if */

function Scm_if() { }

Scm_if.prototype.scm_combine = function(vm, otree, next, tail) {
	var test = scm_compound_elt(otree, 0);
	var consequent = scm_compound_elt(otree, 1);
	var alternative = scm_compound_elt(otree, 2);
	scm_compile(vm, test, scm_insn_test(consequent, alternative, next, tail), false);
	return true;
}

function scm_insn_test(consequent, alternative, next, tail) {
	return function(vm) {
		scm_compile(vm, vm.a ? consequent : alternative, next, tail);
		return true;
	};
}

/* $sequence (optimization) */

function Scm_sequence() { }

Scm_sequence.prototype.scm_combine = function(vm, otree, next, tail) {
	if (scm_is_nil(otree)) {
		vm.a = scm_inert;
		vm.x = next;
	}
	else {
		vm.x = scm_insn_sequence(otree, next);
	}
	return true;
}

function scm_insn_sequence(otree, next) {
	return function(vm) {
		var rest = scm_cdr(otree);
		if (scm_is_nil(rest)) {
			scm_compile(vm, scm_car(otree), next, true); // *
		}
		else {
			scm_compile(vm, scm_car(otree), scm_insn_sequence(rest, next), false);
		}
		return true;
	}
}

/* eval */

function Scm_eval() { }

Scm_eval.prototype.scm_combine = function(vm, args, next, tail) {
	var expr = scm_compound_elt(args, 0);
	var env = scm_compound_elt(args, 1);
	vm.e = env;
	scm_compile(vm, expr, next, true); // *
	return true;
}

/* call/cc */

function Scm_callcc() { }

Scm_callcc.prototype.scm_combine = function(vm, args, next, tail) {
	var combiner = scm_compound_elt(args, 0);
	var k = scm_wrap(new Scm_cont(vm.s));
	scm_compile(vm, scm_cons(combiner, scm_cons(k, scm_nil)), next, true); // *
	return true;
}

function Scm_cont(s) {
	this.s = s;
}

Scm_cont.prototype.scm_combine = function(vm, args, next, tail) {
	var value = scm_compound_elt(args, 0);
	vm.a = value;
	vm.x = scm_insn_return;
	vm.s = this.s;
	return true;
}

/* (*) Note that the eval and call/cc combiners always tail-call the
   expression to eval and the function passed to call/cc,
   respectively.  The reason why this works is because if the combiner
   appeared in tail position itself, the frame it (re-)used is no
   longer needed.  If the combiner did *not* appear in tail position,
   it has already created a fresh frame, which is now free for use of
   the subsequent expression and function call, respectively. */

/**** Native Combiners ****/

function Scm_native(js_fun) {
	this.js_fun = js_fun;
}

Scm_native.prototype.scm_combine = function(vm, args, next, tail) {
	var argslist = scm_cons_list_to_array(args);
	vm.a = this.js_fun.apply(null, argslist);
	vm.x = next;
	return true;
}

function scm_make_native(js_fun) {
	return scm_wrap(new Scm_native(js_fun));
}

/**** Schampignon Hare-Brained Bare-Bones Object System (SCHHBBBOS) ****/

function scm_make_vtable() {
	return {};
}

function scm_make_instance(vt) {
	return { scm_vt: vt };
}

function scm_bind_method(vt, symbol, method) {
	vt[symbol] = method;
	return scm_inert;
}

function scm_lookup_method(obj, symbol) {
	var method = obj.scm_vt[symbol];
	if (!method) scm_error("message not understood: " + symbol);
	return method;
}

function scm_set_slot(obj, symbol, value) {
	obj[symbol] = value;
	return scm_inert;
}

function scm_get_slot(obj, symbol) {
	var value = obj[symbol];
	scm_assert(value !== undefined);
	return value;
}

/**** Environments ****/

var scm_ignore = {};

function scm_is_ignore(obj) {
	return (obj === scm_ignore) || (obj === "#ignore"); // ?
}

function Scm_env(parent) {
	this.parent = parent;
	this.bindings = {};
}

function scm_make_env(parent) {
	return new Scm_env(parent);
}

function scm_lookup(env, name) {
	var value = env.bindings[name];
	if (value !== undefined) return value;
	if (env.parent) return scm_lookup(env.parent, name);
	scm_error("undefined variable:" + name);
}

function scm_update(env, name, value) {
	env.bindings[name] = value;
}

function scm_extend(combiner, otree, denv) {
	var xenv = scm_make_env(combiner.env);
	scm_match(xenv, combiner.ptree, otree);
	if (!scm_is_ignore(combiner.eformal)) scm_update(xenv, combiner.eformal, denv);
	return xenv;
}

function scm_match(env, formal_tree, actual_tree) {
	if (scm_is_nil(formal_tree)) {
		if (!scm_is_nil(actual_tree)) scm_error("match failure: expected nil, got " + actual_tree);
	}
	else if (scm_is_pair(formal_tree)) {
		scm_match(env, scm_car(formal_tree), scm_car(actual_tree));
		scm_match(env, scm_cdr(formal_tree), scm_cdr(actual_tree));
	}
	else if (scm_is_symbol(formal_tree)) {
		if (!scm_is_ignore(formal_tree)) scm_update(env, formal_tree, actual_tree);
	}
	else {
		scm_error("match failure: invalid formal: " + formal_tree);
	}
}

/**** Forms ****/

var scm_nil = null;

function scm_cons(car, cdr) {
	return [car, cdr];
}

function scm_car(cons) {
	scm_assert(scm_is_pair(cons));
	return cons[0];
}

function scm_cdr(cons) {
	scm_assert(scm_is_pair(cons));
	return cons[1];
}

function scm_is_symbol(x) {
	return (typeof (x) === "string");
}

function scm_is_compound(x) {
	return scm_is_nil(x) || scm_is_pair(x);
}

function scm_is_pair(x) {
	return (x instanceof Array);
}

function scm_is_nil(c) {
	return c === scm_nil;
}

function scm_compound_elt(x, i) {
	scm_assert(scm_is_pair(x));
	scm_assert(i >= 0);
	while (i > 0) {
		x = scm_cdr(x);
		i--;
	}
	return scm_car(x);
}

function scm_array_to_cons_list(array, end) {
	var c = end ? end : scm_nil;
	for (var i = array.length; i > 0; i--) c = scm_cons(array[i - 1], c);
	return c;
}

function scm_cons_list_to_array(c) {
	scm_assert(scm_is_compound(c));
	var res = [];
	while (!scm_is_nil(c)) {
		res.push(scm_car(c));
		c = scm_cdr(c);
	}
	return res;
}

/**** Misc ****/

var scm_inert = {};

function scm_eq(a, b) {
	return a === b;
}

function scm_plus(a, b) {
	return a + b;
}

function scm_mult(a, b) {
	return a * b;
}

/**** Utilities ****/

function scm_assert(b) {
	if (!b) scm_error("assertion failed");
}

function scm_error(msg) {
	throw msg;
}

/**** Parser ****/

/* Returns an array of cons lists of the forms in the string. */
function scm_parse(string) {
	var result = scm_program_syntax(ps(string));
	if (result.ast)	return result.ast;
	return scm_error("Reader error", string);
}

var scm_expression_syntax =	function(input) { return scm_expression_syntax(input); }; // forward decl.

var scm_digits = join_action(repeat1(range("0", "9")), "");

var scm_number_syntax =	action(
	sequence(
		optional(choice("+", "-")),
		scm_digits,
		optional(join_action(sequence(".", scm_digits), ""))
	),
	scm_number_syntax_action
);

function scm_number_syntax_action(ast) {
	var sign = ast[0] ? ast[0] : "+";
	var integral_digits = ast[1];
	var fractional_digits = ast[2] || "";
	return Number(sign + integral_digits + fractional_digits);
}

var scm_identifier_special_char = choice(// R5RS sans "."
	"-", "&", "!", ":", "=", ">", "<", "%", "+", "?", "/", "*", "#",
	// Additional
	"$", "_"
);

var scm_identifier_syntax =	action(
	join_action(
		repeat1(
			choice(
				range("a", "z"),
				range("0", "9"),
				scm_identifier_special_char
			)
		),
		""
	),
	scm_identifier_syntax_action
);

function scm_identifier_syntax_action(ast) {
	return ast;
}

var scm_nil_syntax = action("()", scm_nil_syntax_action);

function scm_nil_syntax_action(ast) {
	return scm_nil;
}

var scm_dot_syntax = action(
	wsequence(".", scm_expression_syntax),
	scm_dot_syntax_action
);

function scm_dot_syntax_action(ast) {
	return ast[1];
}

var scm_compound_syntax = action(
	wsequence( "(", repeat1(scm_expression_syntax), optional(scm_dot_syntax), ")" ),
	scm_compound_syntax_action
);

function scm_compound_syntax_action(ast) {
	var exprs = ast[1];
	var end = ast[2] ? ast[2] : scm_nil;
	return scm_array_to_cons_list(exprs, end);
}

var scm_expression_syntax =	whitespace(
	choice(
		scm_number_syntax,
		scm_nil_syntax,
		scm_compound_syntax,
		scm_identifier_syntax
	)
);

var scm_program_syntax = whitespace(repeat1(scm_expression_syntax));
